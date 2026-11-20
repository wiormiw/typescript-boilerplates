import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { ProblemView } from '@starter/contracts';
import { Hono } from 'hono';
import { Lifecycle } from '@starter/lib/lifecycle';
import { captureLogger, recordSpans } from '@starter/lib/testing';
import type { AppEnv } from '#src/shared/http/types.ts';
import { problemHandler } from '#src/middleware/error-handler.ts';
import { currentContext, methodLabel, requestContext } from '#src/middleware/request-context.ts';
import { recordMetrics } from '../support/metrics.ts';
import { testApp } from '../support/app.ts';
import { defaults } from '../support/env.ts';

const meters = recordMetrics();
recordSpans();
const TRACE_ID = /^[0-9a-f]{32}$/;

describe('request context', () => {
	test('sets x-request-id and echoes a valid incoming one', async () => {
		const { app } = testApp();
		const generated = await app.request('/healthz');
		expect(generated.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);

		const echoed = await app.request('/healthz', { headers: { 'x-request-id': 'edge-123' } });
		expect(echoed.headers.get('x-request-id')).toBe('edge-123');
	});

	test('an incoming id that is not a safe token is replaced', async () => {
		const { app } = testApp();
		const res = await app.request('/healthz', { headers: { 'x-request-id': 'a b<script>' } });
		expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
	});

	test('c.var.signal aborts after REQUEST_TIMEOUT_MS and the response is 504 problem+json', async () => {
		const { app } = testApp({ budgetMs: 40 });
		const res = await app.request('/_debug/sleep?ms=1000');
		expect(res.status).toBe(504);
		expect(res.headers.get('content-type')).toContain('application/problem+json');
		const body = v.parse(ProblemView, await res.json());
		expect(body).toMatchObject({ status: 504, code: 'common.request.timeout' });
		expect(body.requestId).toBe(res.headers.get('x-request-id')!);
		// A different id: the request's, not the trace's.
		expect(body.traceId).toMatch(TRACE_ID);
		expect(body.traceId).not.toBe(body.requestId);
	});

	test('an untraced request has a requestId and no traceId in its problem', async () => {
		const { logger } = captureLogger();
		const lifecycle = new Lifecycle(logger);
		// /healthz is untraced, so there is no span to take an id from.
		const app = new Hono<AppEnv>()
			.use(requestContext({ budgetMs: 5000, logger, lifecycle, service: 'starter' }))
			.get('/healthz', () => {
				throw new Error('boom');
			});
		app.onError(problemHandler({ logger, retryAfterS: defaults.SHUTDOWN_RETRY_AFTER_S }));
		const res = await app.request('/healthz');
		const body = v.parse(ProblemView, await res.json());
		expect(body.requestId).toBe(res.headers.get('x-request-id')!);
		expect(body.traceId).toBeUndefined();
	});

	test('the method label is a standard verb, else _OTHER', async () => {
		// The runtime folds an unknown verb into GET before Hono sees it, so the label is checked
		// directly, and the recorded one end to end.
		expect(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map(methodLabel)).toEqual([
			'GET',
			'HEAD',
			'POST',
			'PUT',
			'PATCH',
			'DELETE',
			'OPTIONS',
		]);
		expect(['BREW', 'get', 'PROPFIND', ''].map(methodLabel)).toEqual([
			'_OTHER',
			'_OTHER',
			'_OTHER',
			'_OTHER',
		]);
		const { app } = testApp();
		await meters.collect();
		await app.request('/healthz');
		const duration = (await meters.collect()).find(
			(metric) => metric.descriptor.name === 'http.server.request.duration',
		);
		expect(duration!.dataPoints.map((p) => p.attributes['http.request.method'])).toEqual(['GET']);
	});

	test('client disconnect aborts c.var.signal and records no 5xx', async () => {
		const { app, lines } = testApp();
		let sawAborted: boolean | undefined;
		app.get('/probe', async (c) => {
			await Bun.sleep(500).then(
				() => undefined,
				() => undefined,
			);
			sawAborted = c.var.signal.aborted;
			return c.text('late');
		});
		// Drop what earlier tests recorded.
		await meters.collect();

		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		const gone = await app.request('/_debug/sleep?ms=500', { signal: controller.signal });
		expect(gone.status).toBe(499);
		expect(gone.headers.get('x-request-id')).toBeString();
		expect(gone.headers.get('x-content-type-options')).toBe('nosniff');

		const controller2 = new AbortController();
		setTimeout(() => controller2.abort(), 20);
		await app.request('/probe', { signal: controller2.signal });
		// The probe slept through the abort and then looked at the signal.
		expect(sawAborted).toBe(true);

		expect(
			lines.some((line) => line['msg'] === 'client closed request' && line['level'] === 20),
		).toBe(true);
		expect(lines.some((line) => line['level'] === 50)).toBe(false);

		const duration = (await meters.collect()).find(
			(metric) => metric.descriptor.name === 'http.server.request.duration',
		);
		const statuses = duration!.dataPoints.map((p) => p.attributes['http.response.status_code']);
		expect(statuses).toContain(499);
		expect(statuses.filter((status) => Number(status) >= 500)).toEqual([]);
	});

	test('the duration histogram carries the route template, not the path', async () => {
		const { app } = testApp();
		app.get('/things/:id', (c) => c.text(c.req.param('id')));
		await meters.collect();
		await app.request('/things/42');

		const duration = (await meters.collect()).find(
			(metric) => metric.descriptor.name === 'http.server.request.duration',
		);
		expect(duration!.dataPoints.map((p) => p.attributes['http.route'])).toContain('/things/:id');
	});

	test('a 404 is labelled unmatched', async () => {
		const { app } = testApp();
		await meters.collect();
		await app.request('/no/such/thing');
		const duration = (await meters.collect()).find(
			(metric) => metric.descriptor.name === 'http.server.request.duration',
		);
		expect(duration!.dataPoints.map((p) => p.attributes['http.route'])).toEqual(['unmatched']);
	});

	test('a route behind a middleware-only prefix is labelled by its own template', async () => {
		const { app } = testApp();
		app.use('/api/*', async (_c, next) => next());
		app.get('/api/things/:id', (c) => c.text(c.req.param('id')));
		await meters.collect();
		await app.request('/api/things/9');
		const duration = (await meters.collect()).find(
			(metric) => metric.descriptor.name === 'http.server.request.duration',
		);
		expect(duration!.dataPoints.map((p) => p.attributes['http.route'])).toEqual([
			'/api/things/:id',
		]);
	});

	test('currentContext() inside a handler returns the request id', async () => {
		const { app } = testApp();
		app.get('/who', (c) => c.json({ ...currentContext(), viaVar: c.var.requestId }));
		const res = await app.request('/who', { headers: { 'x-request-id': 'req-7' } });
		const body = (await res.json()) as {
			requestId: string;
			viaVar: string;
			traceId: string | undefined;
		};
		expect(body.requestId).toBe('req-7');
		expect(body.viaVar).toBe('req-7');
		expect(body.traceId).toMatch(TRACE_ID);
		expect(currentContext()).toBeUndefined();
	});

	test('a request cut off by shutdown is a 503 with retry-after', async () => {
		const { app, lifecycle } = testApp();
		setTimeout(() => lifecycle.abort('test'), 20);
		const res = await app.request('/_debug/sleep?ms=1000');
		expect(res.status).toBe(503);
		expect(res.headers.get('retry-after')).toBe(String(defaults.SHUTDOWN_RETRY_AFTER_S));
	});
});
