import { describe, expect, test } from 'bun:test';
import { RuntimeMetrics } from '#src/infra/runtime-metrics.ts';
import { recordMetrics } from '../support/metrics.ts';

const meters = recordMetrics();

const valueOf = async (name: string): Promise<number> => {
	const metric = (await meters.collect()).find((m) => m.descriptor.name === name);
	expect(metric).toBeDefined();
	return Number(metric!.dataPoints[0]!.value);
};

describe('RuntimeMetrics', () => {
	test('gauges report positive rss and heap size', async () => {
		await using metrics = new RuntimeMetrics();
		await metrics.start();
		const all = await meters.collect();
		const gauge = (name: string) =>
			Number(all.find((m) => m.descriptor.name === name)!.dataPoints[0]!.value);
		expect(gauge('process.memory.rss')).toBeGreaterThan(0);
		expect(gauge('bun.heap.size')).toBeGreaterThan(0);
		expect(gauge('bun.heap.capacity')).toBeGreaterThan(0);
		expect(gauge('bun.heap.extra')).toBeGreaterThanOrEqual(0);
		expect(all.map((m) => m.descriptor.name)).toContain('process.cpu.time');
	});

	test('loop delay p99 reflects a 50 ms block', async () => {
		await using metrics = new RuntimeMetrics();
		await metrics.start();
		for (let i = 0; i < 3; i++) {
			const until = performance.now() + 50;
			while (performance.now() < until);
			// Lets the sampling timer fire late, which is what it records.
			await Bun.sleep(25);
		}
		// Seconds, as OpenTelemetry's `s` unit says.
		expect(await valueOf('nodejs.eventloop.delay.p99')).toBeGreaterThanOrEqual(0.04);
	});

	test('disposal stops observing', async () => {
		const metrics = new RuntimeMetrics();
		await metrics.start();
		await meters.collect();
		await metrics[Symbol.asyncDispose]();
		const names = (await meters.collect()).map((m) => m.descriptor.name);
		expect(names).not.toContain('process.memory.rss');
	});
});
