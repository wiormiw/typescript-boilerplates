import { describe, expect, test } from 'bun:test';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { AlwaysOnSampler, ParentBasedSampler } from '@opentelemetry/sdk-trace';
import { OTLPLogExporter as GrpcLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPLogExporter as HttpLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPLogExporter as ProtoLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter as GrpcMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPMetricExporter as HttpMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPMetricExporter as ProtoMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter as GrpcTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { OTLPTraceExporter as HttpTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as ProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
	boundedFlush,
	createOtlpExporters,
	createTelemetry,
	otlpUrls,
	sdkConfiguration,
	shutDownTogether,
} from '@starter/lib/telemetry';

test('a flush that hangs is abandoned at the timeout', async () => {
	const startedAt = performance.now();
	await boundedFlush(() => new Promise<void>(() => {}), 20);
	expect(performance.now() - startedAt).toBeLessThan(1000);
});

test('a flush that fails is swallowed', async () => {
	await boundedFlush(() => Promise.reject(new Error('collector down')), 1000);
});

test('a flush that finishes is waited for', async () => {
	let flushed = false;
	await boundedFlush(async () => {
		await Bun.sleep(5);
		flushed = true;
	}, 1000);
	expect(flushed).toBe(true);
});

describe('observability levels', () => {
	const base = {
		serviceName: 'svc',
		environment: 'test',
		endpoint: 'http://127.0.0.1:1',
		metricIntervalMs: 60_000,
		protocol: 'grpc' as const,
	};

	test('off builds no SDK at all', () => {
		expect(sdkConfiguration({ ...base, level: 'off' })).toBeUndefined();
	});

	test('metrics reads and exports metrics only: no span processor, no context manager', () => {
		const config = sdkConfiguration({ ...base, level: 'metrics' })!;
		expect(config.metricReaders).toHaveLength(1);
		expect(config.spanProcessors).toEqual([]);
		expect(config.contextManager).toBeNull();
	});

	test('metrics+als adds the async-local context manager but still no traces', () => {
		const config = sdkConfiguration({ ...base, level: 'metrics+als' })!;
		expect(config.metricReaders).toHaveLength(1);
		expect(config.spanProcessors).toEqual([]);
		expect(config.contextManager).toBeInstanceOf(AsyncLocalStorageContextManager);
	});

	test('traces-sampled is parent-based over the configured ratio', () => {
		const config = sdkConfiguration({ ...base, level: 'traces-sampled', traceSampleRatio: 0.25 })!;
		expect(config.sampler).toBeInstanceOf(ParentBasedSampler);
		expect(config.sampler!.toString()).toContain('TraceIdRatioBased{0.25}');
		expect(config.traceExporter).toBeDefined();
		expect(config.contextManager).toBeInstanceOf(AsyncLocalStorageContextManager);
	});

	test('traces-full samples everything', () => {
		const config = sdkConfiguration({ ...base, level: 'traces-full' })!;
		expect(config.sampler).toBeInstanceOf(AlwaysOnSampler);
	});

	test('the default level is traces-sampled at 10%', () => {
		const config = sdkConfiguration(base)!;
		expect(config.sampler!.toString()).toContain('TraceIdRatioBased{0.1}');
	});

	test('off yields a disposable that does nothing', async () => {
		await using _telemetry = createTelemetry({ ...base, level: 'off' });
	});

	test('a failing log exporter does not prevent sdk shutdown', async () => {
		let sdkShutDown = false;
		await shutDownTogether([
			() => Promise.reject(new Error('log export is down')),
			async () => {
				sdkShutDown = true;
			},
		]);
		expect(sdkShutDown).toBe(true);
	});
});

describe('exporters match the protocol', () => {
	test('grpc sends to the bare endpoint', () => {
		expect(otlpUrls('grpc', 'http://localhost:4617')).toEqual({
			traces: 'http://localhost:4617',
			metrics: 'http://localhost:4617',
			logs: 'http://localhost:4617',
		});
		const exporters = createOtlpExporters('grpc', 'http://localhost:4617');
		expect(exporters.trace).toBeInstanceOf(GrpcTraceExporter);
		expect(exporters.metric).toBeInstanceOf(GrpcMetricExporter);
		expect(exporters.log).toBeInstanceOf(GrpcLogExporter);
	});

	test('http/protobuf appends the signal path', () => {
		expect(otlpUrls('http/protobuf', 'http://localhost:4618')).toEqual({
			traces: 'http://localhost:4618/v1/traces',
			metrics: 'http://localhost:4618/v1/metrics',
			logs: 'http://localhost:4618/v1/logs',
		});
		const exporters = createOtlpExporters('http/protobuf', 'http://localhost:4618');
		expect(exporters.trace).toBeInstanceOf(ProtoTraceExporter);
		expect(exporters.metric).toBeInstanceOf(ProtoMetricExporter);
		expect(exporters.log).toBeInstanceOf(ProtoLogExporter);
	});

	test('http/json appends the signal path', () => {
		expect(otlpUrls('http/json', 'http://localhost:4618').traces).toBe(
			'http://localhost:4618/v1/traces',
		);
		const exporters = createOtlpExporters('http/json', 'http://localhost:4618');
		expect(exporters.trace).toBeInstanceOf(HttpTraceExporter);
		expect(exporters.metric).toBeInstanceOf(HttpMetricExporter);
		expect(exporters.log).toBeInstanceOf(HttpLogExporter);
	});

	test('a trailing slash on the endpoint does not double up', () => {
		expect(otlpUrls('http/protobuf', 'http://localhost:4618/').logs).toBe(
			'http://localhost:4618/v1/logs',
		);
	});
});

// A child process: createTelemetry registers the global providers, and registering them here
// would starve every other test file of `recordSpans` (they share one process).
test('a dead OTLP endpoint does not block startup or shutdown', async () => {
	const child = Bun.spawn({
		cmd: [process.execPath, new URL('./support/dead-endpoint.ts', import.meta.url).pathname],
		stdout: 'pipe',
		stderr: 'pipe',
	});
	try {
		// stderr is drained too: a full pipe would stall the child, and it explains a failure.
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, err).toBe(0);
		const result = JSON.parse(out.trim().split('\n').at(-1)!) as {
			elapsedMs: number;
			unhandled: number;
			warnings: number;
		};
		expect(result.elapsedMs).toBeLessThan(1000 + 500);
		expect(result.unhandled).toBe(0);
		// Traces, metrics and logs all fail; the rate limit lets one warning through.
		expect(result.warnings).toBe(1);
	} finally {
		child.kill();
	}
}, 15_000);
