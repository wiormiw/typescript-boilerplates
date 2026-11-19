import { describe, expect, test } from 'bun:test';
import { fullJitterDelay, retry } from '@starter/lib/retry';

describe('retry', () => {
	test('full jitter stays in [0, min(cap, base*2^n))', () => {
		expect(fullJitterDelay(10, 100, 5_000, () => 0.999)).toBeLessThan(5_000);
		expect(fullJitterDelay(0, 100, 5_000, () => 0)).toBe(0);
	});

	test('retries a retryable failure until it succeeds', async () => {
		let calls = 0;
		const value = await retry(
			async () => {
				calls += 1;
				if (calls < 3) throw new Error('503');
				return 'ok';
			},
			{ attempts: 5, baseMs: 1, capMs: 5, isRetryable: () => true },
		);
		expect(value).toBe('ok');
		expect(calls).toBe(3);
	});

	test('does not retry a non-retryable error', async () => {
		let calls = 0;
		const result = retry(
			async () => {
				calls += 1;
				throw new Error('400');
			},
			{ attempts: 5, baseMs: 1, capMs: 5, isRetryable: () => false },
		);
		await expect(result).rejects.toThrow('400');
		expect(calls).toBe(1);
	});

	test('retry stops waiting as soon as the signal aborts', async () => {
		const controller = new AbortController();
		const reason = new Error('shutting down');
		const startedAt = performance.now();
		const result = retry(async () => Promise.reject(new Error('503')), {
			attempts: 10,
			baseMs: 10_000,
			capMs: 10_000,
			isRetryable: () => true,
			random: () => 1,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(reason), 20);

		await expect(result).rejects.toBe(reason);
		expect(performance.now() - startedAt).toBeLessThan(100);
	});
});
