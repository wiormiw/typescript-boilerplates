import { describe, expect, test } from 'bun:test';
import { context, trace, TraceFlags } from '@opentelemetry/api';
import {
	InMemoryLogRecordExporter,
	LoggerProvider,
	SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { createLogger } from '@starter/lib/log';
import { recordSpans } from '@starter/lib/testing';

// The shared context manager: a test that registered or disabled its own would break every other
// file in the process (`bun test` runs them together).
recordSpans();

const setup = () => {
	const exporter = new InMemoryLogRecordExporter();
	const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter })] });
	const logger = createLogger({
		level: 'info',
		service: 'test',
		environment: 'test',
		otelLogger: provider.getLogger('test'),
		destination: { write: () => undefined },
	});
	return { exporter, logger };
};

describe('log export', () => {
	test('log lines are exported over OTLP with trace_id when telemetry is on', () => {
		const { exporter, logger } = setup();
		const spanContext = {
			traceId: '0af7651916cd43dd8448eb211c80319c',
			spanId: 'b7ad6b7169203331',
			traceFlags: TraceFlags.SAMPLED,
		};
		const ctx = trace.setSpan(context.active(), trace.wrapSpanContext(spanContext));
		context.with(ctx, () => logger.warn({ route: '/x' }, 'hello'));

		const [record] = exporter.getFinishedLogRecords();
		expect(record?.body).toBe('hello');
		expect(record?.severityText).toBe('WARN');
		expect(record?.spanContext?.traceId).toBe(spanContext.traceId);
		expect(record?.attributes['trace_id']).toBe(spanContext.traceId);
		expect(record?.attributes['route']).toBe('/x');
	});

	test('top-level token, password and authorization are redacted too', () => {
		const { exporter, logger } = setup();
		logger.info({ token: 'top-token', password: 'top-pass', authorization: 'Bearer top' }, 'x');

		const [record] = exporter.getFinishedLogRecords();
		const exported = JSON.stringify(record?.attributes);
		for (const secret of ['top-token', 'top-pass', 'Bearer top']) {
			expect(exported).not.toContain(secret);
		}
	});

	test('redacted fields stay redacted in exported logs', () => {
		const { exporter, logger } = setup();
		logger.info({ user: { token: 'secret-token', note: 'private note' } }, 'login');

		const [record] = exporter.getFinishedLogRecords();
		const exported = JSON.stringify(record?.attributes);
		expect(exported).not.toContain('secret-token');
		expect(exported).not.toContain('private note');
		expect(exported).toContain('[redacted]');
	});
});
