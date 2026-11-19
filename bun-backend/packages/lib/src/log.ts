import {
	ROOT_CONTEXT,
	SeverityNumber,
	trace,
	TraceFlags,
	type Logger as OtelLogger,
} from '@opentelemetry/api';
import { pino, type Logger, type LoggerOptions as LoggerOptionsPino } from 'pino';

export type { Logger } from 'pino';

export interface LoggerOptions {
	level: string;
	service: string;
	environment: string;
	enabled?: boolean;
	/** When given, every record is also emitted to it (OTLP). Stdout output is unchanged. */
	otelLogger?: OtelLogger | undefined;
	/** Where lines are written; stdout by default. Tests pass a sink to stay quiet. */
	destination?: { write(line: string): unknown };
}

const SEVERITY: Record<string, SeverityNumber> = {
	trace: SeverityNumber.TRACE,
	debug: SeverityNumber.DEBUG,
	info: SeverityNumber.INFO,
	warn: SeverityNumber.WARN,
	error: SeverityNumber.ERROR,
	fatal: SeverityNumber.FATAL,
};

/**
 * A pino destination that re-emits each serialized line as an OTel log record. It reads the
 * line pino has already written, so redaction has been applied before anything is exported.
 */
function otelStream(logger: OtelLogger) {
	return {
		write(line: string) {
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line) as Record<string, unknown>;
			} catch {
				return;
			}
			const { level, time, msg, ...attributes } = record;
			const traceId = attributes['trace_id'];
			const spanId = attributes['span_id'];
			logger.emit({
				severityNumber: SEVERITY[String(level)] ?? SeverityNumber.INFO,
				severityText: String(level).toUpperCase(),
				body: typeof msg === 'string' ? msg : '',
				attributes: attributes as Record<string, never>,
				...(typeof time === 'string' ? { timestamp: new Date(time) } : {}),
				// The context carries trace and span ids onto the record's own fields.
				...(typeof traceId === 'string' && typeof spanId === 'string'
					? {
							context: trace.setSpanContext(ROOT_CONTEXT, {
								traceId,
								spanId,
								traceFlags: TraceFlags.SAMPLED,
							}),
						}
					: {}),
			});
		},
	};
}

export function createLogger(options: LoggerOptions): Logger {
	const stdout = options.destination ?? pino.destination(1);
	return pino(
		pinoOptions(options),
		options.otelLogger
			? pino.multistream([{ stream: stdout }, { stream: otelStream(options.otelLogger) }])
			: stdout,
	);
}

function pinoOptions(options: LoggerOptions): LoggerOptionsPino {
	return {
		level: options.level,
		enabled: options.enabled ?? true,
		base: { service: options.service, env: options.environment },
		timestamp: pino.stdTimeFunctions.isoTime,
		formatters: { level: (label) => ({ level: label }) },
		// Every line carries the active trace, so a log search jumps straight into the trace.
		mixin() {
			const span = trace.getActiveSpan();
			if (!span) return {};
			const { traceId, spanId } = span.spanContext();
			return { trace_id: traceId, span_id: spanId };
		},
		redact: {
			paths: [
				// Bare keys cover a top-level field; the wildcards cover one level down.
				'token',
				'password',
				'authorization',
				'*.token',
				'*.password',
				'*.authorization',
				'req.headers.authorization',
				'req.headers.cookie',
				'*.body_md',
				'*.note',
				'*.passwordHash',
				'*.accessToken',
				'*.refreshToken',
				'*.apiKey',
			],
			censor: '[redacted]',
		},
	};
}

/** A logger that writes nothing, for tests and scripts that don't care. */
export const silentLogger = (): Logger => pino({ enabled: false });
