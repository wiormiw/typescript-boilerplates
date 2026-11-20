import {
	INVALID_SPAN_CONTEXT,
	SpanKind,
	SpanStatusCode,
	context,
	propagation,
	trace,
	type Attributes,
	type Span,
	type TextMapGetter,
} from '@opentelemetry/api';
import { isAbortError, isTimeout } from './abort.ts';
import { AppError } from './errors.ts';

/** What `traced` and `tracedChild` take beyond the span's name, attributes and work. */
export interface TracedOptions {
	kind?: SpanKind | undefined;
	/** The signal the work runs under, so its abort reads as cancelled rather than failed. */
	signal?: AbortSignal | undefined;
}

export const tracer = () => trace.getTracer('starter');

/** A returned Result that failed. Recognised structurally, so lib doesn't depend on its callers. */
const isFailedResult = (value: unknown): value is { ok: false; error: AppError } =>
	typeof value === 'object' &&
	value !== null &&
	(value as { ok?: unknown }).ok === false &&
	(value as { error?: unknown }).error instanceof AppError;

/**
 * Whether a throw means "told to stop": the signal the work was given (a shutdown's, say) has
 * aborted, and the throw is its reason or an AbortError. An AbortError with no such signal behind
 * it was something else giving up, which is a failure like any other throw.
 */
const isCancellation = (error: unknown, signal: AbortSignal | undefined): boolean =>
	signal?.aborted === true && (error === signal.reason || isAbortError(error));

/**
 * Marks the span as timed out: work that ran past its deadline failed to answer in time, which
 * is an error worth seeing, unlike a shutdown asking it to stop.
 */
export function recordTimeout(span: Span): void {
	span.recordException({ name: 'TimeoutError', message: 'timeout' });
	span.setAttribute('error.type', 'timeout');
	span.setStatus({ code: SpanStatusCode.ERROR, message: 'timeout' });
}

/**
 * Marks the span for a throw. A timeout is an error (`recordTimeout`), whether the deadline's
 * own TimeoutError or an abort raised by a signal a deadline ended. Any other cancellation, a
 * shutdown say, isn't failing. Otherwise only the error's name and code are recorded: a driver's
 * message can carry row values (an email in a unique violation), and spans leave the process. An
 * AppError's message was written for clients, so it stays.
 */
export function recordThrow(span: Span, error: unknown, signal?: AbortSignal): void {
	const cancelled = isCancellation(error, signal);
	if (isTimeout(error) || (cancelled && isTimeout(signal?.reason))) {
		recordTimeout(span);
		return;
	}
	if (cancelled) {
		span.setAttribute('starter.cancelled', true);
		return;
	}
	const name = error instanceof Error ? error.name : typeof error;
	const code = (error as { code?: unknown } | null)?.code;
	const type = typeof code === 'string' ? code : name;
	const message = error instanceof AppError ? error.message : type;
	span.recordException({ name, message, ...(typeof code === 'string' && { code }) });
	span.setAttribute('error.type', type);
	span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/**
 * Runs `fn` in an active span and always ends it. A throw is recorded by `recordThrow`; a
 * returned `err` marks the span failed with its code, so a business refusal shows in the trace
 * without being an exception. `signal` is the one the work runs under, so its abort reads as
 * cancelled.
 */
export function traced<T>(
	name: string,
	attributes: Attributes,
	fn: (span: Span) => Promise<T>,
	options: TracedOptions = {},
): Promise<T> {
	return tracer().startActiveSpan(
		name,
		{ attributes, ...(options.kind !== undefined && { kind: options.kind }) },
		async (span) => {
			try {
				const value = await fn(span);
				if (isFailedResult(value)) {
					span.setAttribute('starter.error.code', value.error.code);
					span.setStatus({ code: SpanStatusCode.ERROR, message: value.error.message });
				}
				return value;
			} catch (error) {
				recordThrow(span, error, options.signal);
				throw error;
			} finally {
				span.end();
			}
		},
	);
}

/**
 * `traced`, but only under a recording parent: a span with no parent would be a root trace of its
 * own, and a probe every few seconds would fill the backend with them. Without one, `fn` gets an
 * invalid span while the active span stays whatever it was (a sampled-out parent, say), so
 * `currentTraceparent` inside `fn` still carries the trace on, and the sampling decision with it.
 */
export function tracedChild<T>(
	name: string,
	attributes: Attributes,
	fn: (span: Span) => Promise<T>,
	options: TracedOptions = {},
): Promise<T> {
	const parent = trace.getActiveSpan();
	if (parent?.isRecording()) return traced(name, attributes, fn, options);
	return fn(trace.wrapSpanContext(INVALID_SPAN_CONTEXT));
}

export { SpanKind } from '@opentelemetry/api';

// The carrier is ours, `{ traceparent }`, whose key is the lowercase W3C name the propagator asks
// for. Fed raw HTTP headers instead, normalise their keys to lowercase first.
const recordGetter: TextMapGetter<Record<string, string>> = {
	get: (carrier, key) => carrier[key],
	keys: (carrier) => Object.keys(carrier),
};

/**
 * Runs the handling of one consumed message in a consumer span. With the `traceparent` it was
 * published with, the span continues the trace of the request that caused it. `signal` is the
 * handler's, so a handler stopped by it reads as cancelled. The span lifecycle is `traced`'s, so a
 * returned `err` and a throw are recorded the same way for a consumer as for a request.
 */
export function withConsumerSpan<T>(
	name: string,
	traceparent: string | undefined,
	fn: () => Promise<T>,
	attributes?: Attributes,
	signal?: AbortSignal,
): Promise<T> {
	const parent = traceparent
		? propagation.extract(context.active(), { traceparent }, recordGetter)
		: context.active();
	return context.with(parent, () =>
		traced(name, attributes ?? {}, () => fn(), { kind: SpanKind.CONSUMER, signal }),
	);
}

/**
 * The active span as a W3C traceparent, so work done later can join this trace. Written by the
 * registered propagator, the one `withConsumerSpan` reads with, so an invalid span (no SDK, or an
 * untraced path) gives nothing rather than an all-zero header.
 */
export function currentTraceparent(): string | undefined {
	const carrier: Record<string, string> = {};
	propagation.inject(context.active(), carrier);
	return carrier['traceparent'];
}
