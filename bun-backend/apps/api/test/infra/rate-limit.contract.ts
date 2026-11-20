import { expect, test } from 'bun:test';
import type { RateLimitStore } from '#src/infra/types.ts';

/** The contract every RateLimitStore keeps; `wait` moves time (real or fake) forward. */
export function rateLimitStoreContract(
	make: () => RateLimitStore,
	wait: (ms: number) => Promise<void>,
	key: () => string,
) {
	test('max requests pass at once, the next is refused with a retry time', async () => {
		const store = make();
		const bucket = key();
		const rule = { window: 60, max: 3 };
		for (let i = 0; i < 3; i++) expect((await store.consume(bucket, rule)).allowed).toBe(true);
		const refused = await store.consume(bucket, rule);
		expect(refused.allowed).toBe(false);
		// One token comes back every window / max = 20 s.
		expect(refused.retryAfter).toBeGreaterThanOrEqual(1);
		expect(refused.retryAfter).toBeLessThanOrEqual(20);
	});

	test('a token refills after window / max', async () => {
		const store = make();
		const bucket = key();
		const rule = { window: 1, max: 2 };
		await store.consume(bucket, rule);
		await store.consume(bucket, rule);
		expect((await store.consume(bucket, rule)).allowed).toBe(false);
		await wait(600);
		expect((await store.consume(bucket, rule)).allowed).toBe(true);
	});

	test('buckets are separate per key', async () => {
		const store = make();
		const [a, b] = [key(), key()];
		const rule = { window: 60, max: 1 };
		expect((await store.consume(a, rule)).allowed).toBe(true);
		expect((await store.consume(a, rule)).allowed).toBe(false);
		expect((await store.consume(b, rule)).allowed).toBe(true);
	});

	test('concurrent requests cannot all pass: exactly max of them do', async () => {
		const store = make();
		const bucket = key();
		const rule = { window: 60, max: 3 };
		const decisions = await Promise.all(
			Array.from({ length: 10 }, () => store.consume(bucket, rule)),
		);
		expect(decisions.filter((d) => d.allowed)).toHaveLength(3);
	});
}
