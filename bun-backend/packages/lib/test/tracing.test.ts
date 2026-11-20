import { beforeEach, describe, expect, test } from 'bun:test';
import {
	INVALID_SPAN_CONTEXT,
	ROOT_CONTEXT,
	SpanKind,
	SpanStatusCode,
	TraceFlags,
	context,
	trace,
} from '@opentelemetry/api';
import { Forbidden, ErrorCode, RouteNotFound, RequestTimeout } from '@starter/lib/errors';
import { err, ok, type Result } from '@starter/lib/result';
import {
	currentTraceparent,
	traced,
	tracedChild,
	tracer,
	withConsumerSpan,
} from '@starter/lib/tracing';
import { recordSpans } from '@starter/lib/testing';

const recorder = recordSpans();

/** What a span carries out of the process. The span object itself is cyclic. */
const exported = (span: ReturnType<typeof recorder.spans>[number] | undefined) =>
	JSON.stringify({ attributes: span?.attributes, events: span?.events, status: span?.status });
beforeEach(() => recorder.reset());

// A request the head sampler dropped: a valid trace id, flagged not sampled, with no recording span.
const SAMPLED_OUT = {
	traceId: '0af7651916cd43dd8448eb211c80319c',
	spanId: 'b7ad6b7169203331',
	traceFlags: TraceFlags.NONE,
};
const underSampledOutParent = trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(SAMPLED_OUT));

describe('tracedChild', () => {
	test('records no span when there is no active parent', async () => {
		expect(await tracedChild('probe', {}, async () => 1)).toBe(1);
		expect(recorder.spans()).toEqual([]);
	});

	test('records a child span under a recording parent', async () => {
		await tracer().startActiveSpan('parent', async (parent) => {
			await tracedChild('probe', {}, async () => 1);
			parent.end();
		});
		const spans = recorder.spans();
		const probe = spans.find((s) => s.name === 'probe');
		expect(probe?.parentSpanContext?.spanId).toBe(
			spans.find((s) => s.name === 'parent')?.spanContext().spanId,
		);
	});
});

describe('tracedChild under a sampled-out parent', () => {
	test('records nothing, hands fn an invalid span, and leaves the parent active', async () => {
		await context.with(underSampledOutParent, () =>
			tracedChild('probe', {}, async (span) => {
				expect(trace.isSpanContextValid(span.spanContext())).toBe(false);
				expect(trace.getActiveSpan()?.spanContext().traceId).toBe(SAMPLED_OUT.traceId);
			}),
		);
		expect(recorder.spans()).toEqual([]);
	});
});

describe('traced', () => {
	test('ends the span with its attributes on success', async () => {
		expect(await traced('authz.check', { 'starter.test.id': 'r1' }, async () => 7)).toBe(7);
		const [span] = recorder.spans();
		expect(span?.name).toBe('authz.check');
		expect(span?.attributes['starter.test.id']).toBe('r1');
		expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
	});

	test('a successful span leaves its status unset: OK is for operators, not libraries', async () => {
		await traced('x', {}, async () => 1);
		expect(recorder.spans()[0]?.status.code).toBe(SpanStatusCode.UNSET);
	});

	test('a returned err marks the span with its code, without throwing', async () => {
		const result = await traced('realm.approve', {}, async () => err(new Forbidden('Denied.')));
		expect(result.ok).toBe(false);
		const [span] = recorder.spans();
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes['starter.error.code']).toBe('common.auth.forbidden');
	});

	test('an error class is recognised as a failed result, and its type survives', async () => {
		const refuse = async (): Promise<Result<number, Forbidden | RouteNotFound>> =>
			err(new Forbidden('Denied.'));
		const result: Result<number, Forbidden | RouteNotFound> = await traced(
			'realm.found',
			{},
			refuse,
		);
		expect(result.ok).toBe(false);
		expect(recorder.spans()[0]?.attributes['starter.error.code']).toBe('common.auth.forbidden');
	});

	test('a throw is recorded and rethrown', async () => {
		await expect(
			traced('mail.send', {}, async () => {
				throw new Error('down');
			}),
		).rejects.toThrow('down');
		expect(recorder.spans()[0]?.events[0]?.name).toBe('exception');
	});

	test("an AbortError is cancelled once the work's signal has aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error('shutting down: SIGTERM'));
		const reason = new DOMException('stop', 'AbortError');
		await expect(
			traced(
				'authz.check',
				{},
				async () => {
					throw reason;
				},
				{ signal: controller.signal },
			),
		).rejects.toBe(reason);
		const [span] = recorder.spans();
		expect(span?.attributes['starter.cancelled']).toBe(true);
		expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
	});

	test('an AbortError with no aborted signal behind it is an error', async () => {
		const reason = new DOMException('stop', 'AbortError');
		const live = new AbortController();
		for (const signal of [undefined, live.signal]) {
			await expect(
				traced(
					'x',
					{},
					async () => {
						throw reason;
					},
					{ signal },
				),
			).rejects.toBe(reason);
		}
		for (const span of recorder.spans()) {
			expect(span.attributes['starter.cancelled']).toBeUndefined();
			expect(span.status.code).toBe(SpanStatusCode.ERROR);
			expect(span.attributes['error.type']).toBe('AbortError');
		}
	});

	test('a TimeoutError is an error of type timeout, with or without its signal', async () => {
		const reason = new DOMException('late', 'TimeoutError');
		const controller = new AbortController();
		controller.abort(reason);
		const late = async () => {
			throw reason;
		};
		await expect(traced('x', {}, late, { signal: controller.signal })).rejects.toBe(reason);
		await expect(traced('y', {}, late)).rejects.toBe(reason);
		expect(recorder.spans()).toHaveLength(2);
		for (const span of recorder.spans()) {
			expect(span.status.code).toBe(SpanStatusCode.ERROR);
			expect(span.attributes['error.type']).toBe('timeout');
			expect(span.attributes['starter.cancelled']).toBeUndefined();
		}
	});

	test('an AbortError raised because a deadline ended is a timeout too', async () => {
		const controller = new AbortController();
		controller.abort(new DOMException('late', 'TimeoutError'));
		const aborted = new DOMException('aborted', 'AbortError');
		await expect(
			traced(
				'x',
				{},
				async () => {
					throw aborted;
				},
				{ signal: controller.signal },
			),
		).rejects.toBe(aborted);
		const [span] = recorder.spans();
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes['error.type']).toBe('timeout');
	});

	test('a shutdown abort is cancelled, not an error', async () => {
		const reason = new Error('shutting down: SIGTERM');
		const controller = new AbortController();
		controller.abort(reason);
		await expect(
			traced(
				'x',
				{},
				async () => {
					throw controller.signal.reason;
				},
				{ signal: controller.signal },
			),
		).rejects.toBe(reason);
		const [span] = recorder.spans();
		expect(span?.attributes['starter.cancelled']).toBe(true);
		expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
		expect(span?.events).toEqual([]);
	});

	test('a plain Error named AbortError, once the signal aborted, is cancelled too', async () => {
		// Libraries and polyfills throw their own AbortError rather than the signal's reason.
		const controller = new AbortController();
		controller.abort(new Error('shutting down: SIGTERM'));
		const theirs = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
		await expect(
			traced(
				'x',
				{},
				async () => {
					throw theirs;
				},
				{ signal: controller.signal },
			),
		).rejects.toBe(theirs);
		const [span] = recorder.spans();
		expect(span?.attributes['starter.cancelled']).toBe(true);
		expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
	});

	test("an unexpected error's message is not recorded, only its name and code", async () => {
		const pgError = Object.assign(
			new Error(
				'duplicate key value violates unique constraint "user_email_key": (email)=(ann@example.test)',
			),
			{ code: '23505' },
		);
		await expect(
			traced('x', {}, async () => {
				throw pgError;
			}),
		).rejects.toBe(pgError);
		const [span] = recorder.spans();
		expect(exported(span)).not.toContain('ann@example.test');
		expect(span?.attributes['error.type']).toBe('23505');
		expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: '23505' });
	});

	test('an AppError keeps its message: it was written for clients', async () => {
		const failure = new RequestTimeout('The request took too long.');
		await expect(
			traced('x', {}, async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		const [span] = recorder.spans();
		expect(span?.events[0]?.attributes?.['exception.message']).toBe('The request took too long.');
		expect(span?.attributes['error.type']).toBe(ErrorCode.common.timeout);
	});

	test("a throw that is not the signal's reason is an error even once the signal aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error('shutting down: SIGTERM'));
		const other = new TypeError('boom');
		await expect(
			traced(
				'x',
				{},
				async () => {
					throw other;
				},
				{ signal: controller.signal },
			),
		).rejects.toBe(other);
		const [span] = recorder.spans();
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes['error.type']).toBe('TypeError');
	});

	test('an ok value passes through untouched', async () => {
		expect(await traced('x', {}, async () => ok(1))).toEqual(ok(1));
	});
});

describe('withConsumerSpan', () => {
	test('a handler that timed out is an error of type timeout', async () => {
		const controller = new AbortController();
		const reason = new DOMException('late', 'TimeoutError');
		controller.abort(reason);
		await expect(
			withConsumerSpan(
				'consume x',
				undefined,
				async () => {
					throw reason;
				},
				{},
				controller.signal,
			),
		).rejects.toBe(reason);
		const [span] = recorder.spans();
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes['error.type']).toBe('timeout');
	});

	test("an AbortError while shutdown hasn't begun is the handler's error", async () => {
		const shutdown = new AbortController();
		const aborted = new DOMException('aborted', 'AbortError');
		await expect(
			withConsumerSpan(
				'consume x',
				undefined,
				async () => {
					throw aborted;
				},
				{},
				shutdown.signal,
			),
		).rejects.toBe(aborted);
		const [span] = recorder.spans();
		expect(span?.attributes['starter.cancelled']).toBeUndefined();
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
	});

	test('a handler stopped by shutdown is cancelled, not an error', async () => {
		const controller = new AbortController();
		const reason = new Error('shutting down: SIGTERM');
		controller.abort(reason);
		await expect(
			withConsumerSpan(
				'consume x',
				undefined,
				async () => {
					throw reason;
				},
				{},
				controller.signal,
			),
		).rejects.toBe(reason);
		const [span] = recorder.spans();
		expect(span?.attributes['starter.cancelled']).toBe(true);
		expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
	});

	test('a successful handler leaves the status unset, as traced does', async () => {
		await withConsumerSpan('consume x', undefined, async () => 1);
		expect(recorder.spans()[0]?.status.code).toBe(SpanStatusCode.UNSET);
	});

	test('a returned err marks the span failed, as traced does', async () => {
		const result = await withConsumerSpan('consume x', undefined, async () =>
			err(new Forbidden('Denied.')),
		);
		expect(result.ok).toBe(false);
		const [span] = recorder.spans();
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes['starter.error.code']).toBe('common.auth.forbidden');
	});

	test('the span is a consumer span carrying the given attributes', async () => {
		await withConsumerSpan('consume x', undefined, async () => 1, { 'messaging.system': 'test' });
		const [span] = recorder.spans();
		expect(span?.kind).toBe(SpanKind.CONSUMER);
		expect(span?.attributes['messaging.system']).toBe('test');
	});

	test("a handler's error records its code, not its message", async () => {
		const failure = Object.assign(new Error('secret@example.test'), { code: 'ECONNRESET' });
		await expect(
			withConsumerSpan('consume x', undefined, async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		const [span] = recorder.spans();
		expect(exported(span)).not.toContain('secret@example.test');
		expect(span?.attributes['error.type']).toBe('ECONNRESET');
	});
});

describe('currentTraceparent', () => {
	test('is undefined with no active span', () => {
		expect(currentTraceparent()).toBeUndefined();
	});

	test('is the active span as a W3C traceparent', async () => {
		const header = await traced('publish', {}, async () => currentTraceparent());
		const [span] = recorder.spans();
		const { traceId, spanId } = span!.spanContext();
		expect(header).toBe(`00-${traceId}-${spanId}-01`);
	});

	test('a sampled-out parent still propagates, flagged 00, so the decision follows the trace', () => {
		const header = context.with(underSampledOutParent, () => currentTraceparent());
		expect(header).toBe(`00-${SAMPLED_OUT.traceId}-${SAMPLED_OUT.spanId}-00`);
	});

	test('is undefined for a span with no valid context, rather than an all-zero header', () => {
		// What the no-op tracer hands out when telemetry is off.
		const none = trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(INVALID_SPAN_CONTEXT));
		expect(context.with(none, () => currentTraceparent())).toBeUndefined();
	});
});

describe('propagation', () => {
	test('a consumer of a sampled-out trace is sampled out too, not sampled on its own', async () => {
		const header = `00-${SAMPLED_OUT.traceId}-${SAMPLED_OUT.spanId}-00`;
		expect(await withConsumerSpan('consume x', header, async () => 1)).toBe(1);
		expect(recorder.spans()).toEqual([]);
	});

	test("a consumer span continues the producer's trace", async () => {
		const parent = await traced('publish', {}, async () => currentTraceparent());
		await withConsumerSpan('consume realm.member_changed', parent, async () => undefined);
		const [producer, consumer] = recorder.spans();
		expect(consumer?.spanContext().traceId).toBe(producer?.spanContext().traceId);
	});
});
