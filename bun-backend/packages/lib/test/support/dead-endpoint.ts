// Run by telemetry.test.ts in its own process: emits telemetry at a closed port and reports how
// long disposal took and how noisy the failure was.
import { trace } from '@opentelemetry/api';
import { createTelemetry } from '@starter/lib/telemetry';

let warnings = 0;
let unhandled = 0;
console.warn = () => void warnings++;
process.on('unhandledRejection', () => void unhandled++);

const startedAt = performance.now();
const telemetry = createTelemetry({
	serviceName: 'svc',
	environment: 'test',
	endpoint: 'http://127.0.0.1:1',
	metricIntervalMs: 60_000,
	protocol: 'grpc',
	level: 'traces-full',
	flushTimeoutMs: 1000,
});
telemetry.logger?.emit({ body: 'hello from a dead endpoint' });
trace.getTracer('t').startSpan('s').end();
await telemetry[Symbol.asyncDispose]();
const elapsedMs = performance.now() - startedAt;
await Bun.sleep(100);
console.log(JSON.stringify({ elapsedMs, unhandled, warnings }));
process.exit(0);
