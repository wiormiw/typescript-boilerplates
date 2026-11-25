import type { ContextManager, Logger as OtelLogger } from '@opentelemetry/api';
import { OTLPLogExporter as GrpcLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPLogExporter as HttpLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPLogExporter as ProtoLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter as GrpcMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPMetricExporter as HttpMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPMetricExporter as ProtoMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter as GrpcTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPTraceExporter as HttpTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as ProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
	BatchLogRecordProcessor,
	LoggerProvider,
	SimpleLogRecordProcessor,
	type LogRecordExporter,
} from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader, type PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { NodeSDK, type NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import {
	AlwaysOnSampler,
	ParentBasedSampler,
	TraceIdRatioBasedSampler,
	type SpanExporter,
} from '@opentelemetry/sdk-trace';
import {
	ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import {
	DEFAULT_OBSERVABILITY_LEVEL,
	DEFAULT_TRACE_SAMPLE_RATIO,
	type ObservabilityLevel,
	type OtlpProtocol,
} from './observability.ts';

export interface OtlpUrls {
	traces: string;
	metrics: string;
	logs: string;
}

export interface OtlpExporters {
	trace: SpanExporter;
	metric: PushMetricExporter;
	log: LogRecordExporter;
}

export interface TelemetryOptions {
	serviceName: string;
	environment: string;
	/** Base address of the collector: `http://host:4617` for grpc, `http://host:4618` for HTTP. */
	endpoint: string;
	protocol: OtlpProtocol;
	metricIntervalMs: number;
	/** How long disposal waits for the final flush. Default 3000. */
	flushTimeoutMs?: number;
	/** How much to collect. Defaults to `DEFAULT_OBSERVABILITY_LEVEL`. */
	level?: ObservabilityLevel;
	/** Share of root traces kept at 'traces-sampled'. Defaults to `DEFAULT_TRACE_SAMPLE_RATIO`. */
	traceSampleRatio?: number;
	/** Replaces the OTLP log exporter (tests); records then export synchronously. */
	logExporter?: LogRecordExporter;
}

/**
 * Where each signal goes. gRPC takes the bare address (the service name is the route); both HTTP
 * flavours add the per-signal path.
 */
export function otlpUrls(protocol: OtlpProtocol, endpoint: string): OtlpUrls {
	if (protocol === 'grpc') return { traces: endpoint, metrics: endpoint, logs: endpoint };
	const base = endpoint.replace(/\/+$/, '');
	return {
		traces: `${base}/v1/traces`,
		metrics: `${base}/v1/metrics`,
		logs: `${base}/v1/logs`,
	};
}

export interface ExportFailureWarnerOptions {
	/** The least time between two warnings, in ms. Default 60 000. */
	intervalMs?: number;
	/** The clock, in ms; a test moves it. Default `Date.now`. */
	now?: () => number;
	/** Where a warning goes. Default `console.warn`. */
	warn?: (message: string) => void;
}

/** What `watch` needs of an OTLP exporter. */
interface Exportable<Items> {
	export(items: Items, done: (result: ExportResult) => void): void;
}

export interface ExportFailureWarner {
	/** Wraps `exporter.export`: a failed export may warn, and its result always reaches `done`. */
	watch<Items>(exporter: Exportable<Items>, signal: string, endpoint: string): void;
}

/**
 * The SDK reports a failed export only through its diag logger, which is off unless
 * OTEL_LOG_LEVEL is set, so a wrong protocol/endpoint pair would otherwise be invisible. This
 * warns at most once per interval, whatever the signal or the number of failures. When it last
 * warned is state, so each warner keeps its own rather than the process sharing one.
 */
export function createExportFailureWarner(
	options: ExportFailureWarnerOptions = {},
): ExportFailureWarner {
	let lastAt = -Infinity;
	const intervalMs = options.intervalMs ?? 60_000;
	const now = options.now ?? Date.now;
	const warn = options.warn ?? ((message: string) => console.warn(message));

	function failed(signal: string, endpoint: string, result: ExportResult): void {
		const at = now();
		if (at - lastAt < intervalMs) return;
		lastAt = at;
		warn(
			`telemetry: exporting ${signal} to ${endpoint} failed (${result.error?.message ?? 'unknown error'}); further failures are not reported for ${Math.round(intervalMs / 1000)} s`,
		);
	}

	return {
		watch<Items>(exporter: Exportable<Items>, signal: string, endpoint: string): void {
			const original = exporter.export.bind(exporter);
			exporter.export = (items, done) =>
				original(items, (result) => {
					if (result.code !== ExportResultCode.SUCCESS) failed(signal, endpoint, result);
					done(result);
				});
		},
	};
}

/**
 * The three exporters for a protocol, sharing one warner. Pure construction: nothing connects
 * until the first export.
 */
export function createOtlpExporters(
	protocol: OtlpProtocol,
	endpoint: string,
	warner: ExportFailureWarner = createExportFailureWarner(),
): OtlpExporters {
	const exporters = buildExporters(protocol, otlpUrls(protocol, endpoint));
	warner.watch(exporters.trace, 'traces', endpoint);
	warner.watch(exporters.metric, 'metrics', endpoint);
	warner.watch(exporters.log, 'logs', endpoint);
	return exporters;
}

function buildExporters(protocol: OtlpProtocol, url: OtlpUrls): OtlpExporters {
	switch (protocol) {
		case 'grpc':
			return {
				trace: new GrpcTraceExporter({ url: url.traces }),
				metric: new GrpcMetricExporter({ url: url.metrics }),
				log: new GrpcLogExporter({ url: url.logs }),
			};
		case 'http/protobuf':
			return {
				trace: new ProtoTraceExporter({ url: url.traces }),
				metric: new ProtoMetricExporter({ url: url.metrics }),
				log: new ProtoLogExporter({ url: url.logs }),
			};
		case 'http/json':
			return {
				trace: new HttpTraceExporter({ url: url.traces }),
				metric: new HttpMetricExporter({ url: url.metrics }),
				log: new HttpLogExporter({ url: url.logs }),
			};
	}
}

/**
 * Runs `flush`, giving up after `timeoutMs`; never throws. With the collector down an export
 * waits out its own retries (about 8s), which would eat most of the shutdown deadline.
 */
export async function boundedFlush(flush: () => Promise<void>, timeoutMs: number): Promise<void> {
	let timer: Timer | undefined;
	const giveUp = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeoutMs);
	});
	try {
		await Promise.race([flush().catch(() => undefined), giveUp]);
	} finally {
		clearTimeout(timer);
	}
}

/** Starts every shutdown at once and waits for all, so one that throws or hangs skips no other. */
export async function shutDownTogether(steps: (() => Promise<void>)[]): Promise<void> {
	await Promise.allSettled(steps.map((step) => step()));
}

/**
 * What each level hands the SDK; `undefined` means no SDK at all. Split from `createTelemetry`
 * so the choices can be asserted without registering process-global providers.
 */
export function sdkConfiguration(
	options: TelemetryOptions,
	given?: OtlpExporters,
): Partial<NodeSDKConfiguration> | undefined {
	const level = options.level ?? DEFAULT_OBSERVABILITY_LEVEL;
	if (level === 'off') return undefined;

	const exporters = given ?? createOtlpExporters(options.protocol, options.endpoint);
	const base: Partial<NodeSDKConfiguration> = {
		resource: resourceFromAttributes({
			[ATTR_SERVICE_NAME]: options.serviceName,
			[ATTR_SERVICE_VERSION]: Bun.env['npm_package_version'] ?? '0.0.0',
			[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment,
		}),
		// Pushed to the Collector rather than scraped: a short-lived pod still reports.
		metricReaders: [
			new PeriodicExportingMetricReader({
				exporter: exporters.metric,
				exportIntervalMillis: options.metricIntervalMs,
			}),
		],
	};

	if (level === 'metrics' || level === 'metrics+als') {
		return {
			...base,
			// An empty list, not an omission: with none given the SDK reads OTEL_TRACES_EXPORTER
			// and would start exporting traces anyway.
			spanProcessors: [],
			// The SDK treats null as "install none" (undefined installs its own), but its type omits it.
			contextManager:
				level === 'metrics+als'
					? new AsyncLocalStorageContextManager()
					: (null as unknown as ContextManager),
		};
	}
	return {
		...base,
		traceExporter: exporters.trace,
		contextManager: new AsyncLocalStorageContextManager(),
		sampler:
			level === 'traces-full'
				? new AlwaysOnSampler()
				: // Honours the caller's decision, so a trace is kept or dropped whole.
					new ParentBasedSampler({
						root: new TraceIdRatioBasedSampler(
							options.traceSampleRatio ?? DEFAULT_TRACE_SAMPLE_RATIO,
						),
					}),
	};
}

/**
 * Exports traces, metrics and logs to the collector, as far as the level asks. The container
 * creates it right after config and starts it before anything records a span, and disposes it
 * last, so spans recorded during shutdown are flushed; it is not in the `ResourceStack`, which is
 * disposed before it. Constructing registers nothing: `start` registers the global tracer and
 * meter providers, so a test of the constructor is safe in a shared process.
 *
 * No instrumentations are configured, so nothing is patched and nothing needs a `--preload`:
 * spans come from our own `traced` calls, and the OTel API's proxy tracer picks up the provider
 * whenever `start` runs.
 */
export class Telemetry implements AsyncDisposable {
	/** Where log records go; undefined when the level is 'off'. Hand it to `createLogger`. */
	readonly logger: OtelLogger | undefined;
	#configuration: Partial<NodeSDKConfiguration> | undefined;
	#logs: LoggerProvider | undefined;
	#sdk: NodeSDK | undefined;
	#flushTimeoutMs: number;
	#disposal: Promise<void> | undefined;

	constructor(options: TelemetryOptions) {
		this.#flushTimeoutMs = options.flushTimeoutMs ?? 3000;
		// One set of exporters for all three signals, and none at all when the level is off.
		const exporters =
			(options.level ?? DEFAULT_OBSERVABILITY_LEVEL) === 'off'
				? undefined
				: createOtlpExporters(options.protocol, options.endpoint);
		this.#configuration = exporters && sdkConfiguration(options, exporters);
		if (!exporters || !this.#configuration) return;

		// A provider of its own, not the global one: the logger is handed to whoever needs it.
		this.#logs = new LoggerProvider({
			...(this.#configuration.resource ? { resource: this.#configuration.resource } : {}),
			processors: [
				options.logExporter
					? new SimpleLogRecordProcessor({ exporter: options.logExporter })
					: new BatchLogRecordProcessor({ exporter: exporters.log }),
			],
		});
		this.logger = this.#logs.getLogger(options.serviceName);
	}

	/** Registers the global providers and starts exporting. Once; nothing at level 'off'. */
	start(): void {
		if (this.#sdk || !this.#configuration) return;
		this.#sdk = new NodeSDK(this.#configuration);
		this.#sdk.start();
	}

	/** Flushes and shuts down, bounded so a dead collector can't hold up the exit. Idempotent. */
	[Symbol.asyncDispose](): Promise<void> {
		this.#disposal ??= boundedFlush(async () => {
			await shutDownTogether([
				async () => void (await this.#logs?.shutdown()),
				async () => void (await this.#sdk?.shutdown()),
			]);
		}, this.#flushTimeoutMs);
		return this.#disposal;
	}
}
