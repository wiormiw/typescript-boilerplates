// The values telemetry and logging settings may take, and what each means when not given, written
// once. Kept free of imports so config can read them without pulling in the OpenTelemetry SDK;
// each type is derived from its tuple.

/** How OTLP data travels to the collector. */
export const OTLP_PROTOCOLS = ['grpc', 'http/protobuf', 'http/json'] as const;
export type OtlpProtocol = (typeof OTLP_PROTOCOLS)[number];

/** How much telemetry to collect, from none to every trace. */
export const OBSERVABILITY_LEVELS = [
	'off',
	'metrics',
	'metrics+als',
	'traces-sampled',
	'traces-full',
] as const;
export type ObservabilityLevel = (typeof OBSERVABILITY_LEVELS)[number];

/** The level when none is given. */
export const DEFAULT_OBSERVABILITY_LEVEL: ObservabilityLevel = 'traces-sampled';

/** The share of root traces kept at `traces-sampled`, when none is given. */
export const DEFAULT_TRACE_SAMPLE_RATIO = 0.1;

/** Log levels, least to most severe. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
