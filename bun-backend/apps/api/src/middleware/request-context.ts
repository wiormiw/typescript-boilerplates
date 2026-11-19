import { AsyncLocalStorage } from 'node:async_hooks';
import { httpInstrumentationMiddleware } from '@hono/otel';
import { createNoopMeter, metrics, trace, type MeterProvider, type Span } from '@opentelemetry/api';
import { createMiddleware } from 'hono/factory';
import { RequestTimeout } from '@starter/lib/errors';
import { LATENCY_BUCKETS_S } from '@starter/lib/metrics';
import { recordThrow, recordTimeout } from '@starter/lib/tracing';
import type { AppEnv, HttpDeps, RequestContext } from '#src/shared/http/types.ts';
import { problemResponse } from '#src/shared/http/problem.ts';

interface RequestContextOptions extends HttpDeps {
	/** The service name on the server span. */
	service: string;
}

export const REQUEST_ID_HEADER = 'x-request-id';

// @hono/otel records its own `http.server.request.duration`; this hands it a meter that drops
// everything, so ours (route templates, second buckets) is the only recorder.
const NO_METRICS: MeterProvider = { getMeter: () => createNoopMeter() };

// A proxy's id is echoed into logs and headers, so only a plain token is trusted.
const SAFE_REQUEST_ID = /^[\w.:-]{1,128}$/;

// Semantic-convention names, as @hono/otel sets them.
const ATTR_URL_FULL = 'url.full';
const ATTR_URL_QUERY = 'url.query';

// Probed every few seconds by the orchestrator; a trace each would bury the real traffic.
const UNTRACED_PATHS = new Set(['/healthz', '/readyz']);

// A method label from the client would make a series per invented verb.
const STANDARD_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** The `http.request.method` label: a standard verb, else `_OTHER`. */
export const methodLabel = (method: string): string =>
	STANDARD_METHODS.has(method) ? method : '_OTHER';

const store = new AsyncLocalStorage<RequestContext>();

/** The running request's id, trace and logger, for code that isn't handed them; undefined outside one. */
export const currentContext = (): RequestContext | undefined => store.getStore();

/**
 * @hono/otel records `url.full` as the request URL, query and all; a query can carry a searched
 * email. The span keeps the origin and path only.
 */
function scrubUrl(span: Span | undefined, url: string) {
	if (!span) return;
	const { origin, pathname } = new URL(url);
	span.setAttribute(ATTR_URL_FULL, origin + pathname);
	// A span can't drop an attribute, so a query someone set is overwritten.
	// The SDK's span exposes what it holds; the API's interface doesn't say so.
	const attributes = (span as { attributes?: Record<string, unknown> }).attributes;
	if (attributes && ATTR_URL_QUERY in attributes) span.setAttribute(ATTR_URL_QUERY, 'REDACTED');
}

/**
 * The template of the route that answered. Read from the matched list rather than `routePath`,
 * which follows Hono's dispatch index and can name a middleware (`/*`) after `next()` returns.
 * Middleware registers as ALL; nothing but it matching means no route did.
 */
function routeTemplate(matched: readonly { method: string; path: string }[]): string {
	const route = matched.findLast((entry) => entry.method !== 'ALL');
	return route?.path ?? 'unmatched';
}

/** A server span, a request id, a deadline signal, a duration metric and one access-log line. */
export function requestContext(options: RequestContextOptions) {
	const log = options.logger.child({ component: 'http' });
	const traced = httpInstrumentationMiddleware({
		serviceName: options.service,
		meterProvider: NO_METRICS,
	});
	const duration = metrics.getMeter('starter').createHistogram('http.server.request.duration', {
		unit: 's',
		description: 'Duration of inbound HTTP requests.',
		// Seconds-scale buckets: the SDK default boundaries are milliseconds, so every sample would land
		// in the first bucket and the quantiles would be meaningless.
		advice: { explicitBucketBoundaries: LATENCY_BUCKETS_S },
	});

	const context = createMiddleware<AppEnv>(async (c, next) => {
		const startedAt = performance.now();
		const incoming = c.req.header(REQUEST_ID_HEADER);
		// Honours the proxy's id, so one id follows the request end to end.
		const requestId =
			incoming !== undefined && SAFE_REQUEST_ID.test(incoming) ? incoming : Bun.randomUUIDv7();
		const requestLog = log.child({ requestId });
		c.set('requestId', requestId);
		c.set('logger', requestLog);
		const deadline = AbortSignal.timeout(options.budgetMs);
		c.set('signal', AbortSignal.any([c.req.raw.signal, deadline, options.lifecycle.signal]));
		c.header(REQUEST_ID_HEADER, requestId);

		// Without a tracer (or on an untraced path) there is no span, or one with an all-zero id.
		const spanContext = trace.getActiveSpan()?.spanContext();
		const traceId =
			spanContext && trace.isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
		if (traceId) c.set('traceId', traceId);
		await store.run({ requestId, traceId, logger: requestLog }, next);

		// Checked after the handler rather than raced against it, so nothing keeps running once the
		// response is sent.
		if (deadline.aborted && !c.req.raw.signal.aborted && c.res.status < 400) {
			c.res = problemResponse(c, new RequestTimeout());
			// The server span (none on untraced paths) says so too. A handler that threw instead is
			// recorded from `c.error` below.
			const span = trace.getActiveSpan();
			if (span) recordTimeout(span);
		}
		const elapsedMs = performance.now() - startedAt;
		// The route template, never the path: an id in the path would make every request a new series.
		duration.record(elapsedMs / 1000, {
			'http.request.method': methodLabel(c.req.method),
			'http.route': routeTemplate(c.req.matchedRoutes),
			'http.response.status_code': c.res.status,
		});
		requestLog.info(
			{ method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(elapsedMs) },
			'request',
		);
	});

	return createMiddleware<AppEnv>((c, next) =>
		UNTRACED_PATHS.has(c.req.path)
			? context(c, next)
			: traced(c, async () => {
					scrubUrl(trace.getActiveSpan(), c.req.url);
					await context(c, next);
					// @hono/otel records `c.error` as is, message and stack, when it ends the server span;
					// a driver's message can carry row values. Record it scrubbed here and leave it nothing.
					// The problem response and its log line were written before this point.
					if (c.error) {
						const span = trace.getActiveSpan();
						if (span) recordThrow(span, c.error, c.get('signal'));
						c.error = undefined;
					}
				}),
	);
}
