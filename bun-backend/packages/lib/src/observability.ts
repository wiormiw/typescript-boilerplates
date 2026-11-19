// The values telemetry settings may take, written once. Kept free of imports so config can read
// them without pulling in the OpenTelemetry SDK; each type is derived from its tuple.

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
