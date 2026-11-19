import { monitorEventLoopDelay } from 'node:perf_hooks';
import { metrics, type Observable, type ObservableCallback } from '@opentelemetry/api';
import { heapStats } from 'bun:jsc';
import type { Resource } from '@starter/lib/lifecycle';

const LOOP_RESOLUTION_MS = 10;
const NS_PER_SECOND = 1e9;
const US_PER_SECOND = 1e6;

/**
 * Process and event-loop gauges, read when the metric reader collects. Bun has no
 * `@opentelemetry/instrumentation-runtime-node`, so these are the ones its own APIs can answer.
 */
export class RuntimeMetrics implements Resource {
	readonly name = 'runtime-metrics';
	#loop: ReturnType<typeof monitorEventLoopDelay> | undefined;
	#detach: (() => void) | undefined;

	async start(): Promise<void> {
		if (this.#loop) return;
		const loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
		loop.enable();
		this.#loop = loop;

		// Resolved here, not at import, so the provider the container registered is the one used.
		const meter = metrics.getMeter('starter');
		const bytes = (name: string, description: string) =>
			meter.createObservableGauge(name, { unit: 'By', description });
		const observed: [Observable, ObservableCallback][] = [];
		const watch = (instrument: Observable, read: ObservableCallback) => {
			instrument.addCallback(read);
			observed.push([instrument, read]);
		};

		watch(bytes('process.memory.rss', 'Resident set size.'), (r) =>
			r.observe(process.memoryUsage.rss()),
		);
		watch(bytes('bun.heap.size', 'JavaScriptCore heap in use.'), (r) =>
			r.observe(heapStats().heapSize),
		);
		watch(bytes('bun.heap.capacity', 'JavaScriptCore heap capacity.'), (r) =>
			r.observe(heapStats().heapCapacity),
		);
		watch(bytes('bun.heap.extra', 'Memory held outside the heap by heap objects.'), (r) =>
			r.observe(heapStats().extraMemorySize),
		);
		watch(
			meter.createObservableGauge('nodejs.eventloop.delay.p99', {
				unit: 's',
				description: '99th percentile event loop delay since the last collection.',
			}),
			(r) => {
				r.observe(loop.percentile(99) / NS_PER_SECOND);
				// A window per collection, so a block an hour ago doesn't keep the number high.
				loop.reset();
			},
		);
		watch(
			meter.createObservableCounter('process.cpu.time', {
				unit: 's',
				description: 'CPU time used by the process.',
			}),
			(r) => {
				const usage = process.cpuUsage();
				r.observe(usage.user / US_PER_SECOND, { 'cpu.mode': 'user' });
				r.observe(usage.system / US_PER_SECOND, { 'cpu.mode': 'system' });
			},
		);
		this.#detach = () => {
			for (const [instrument, read] of observed) instrument.removeCallback(read);
		};
	}

	[Symbol.asyncDispose](): Promise<void> {
		this.#detach?.();
		this.#detach = undefined;
		this.#loop?.disable();
		this.#loop = undefined;
		return Promise.resolve();
	}
}
