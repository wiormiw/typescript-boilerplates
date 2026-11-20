import { afterAll, describe, expect, test } from 'bun:test';
import { captureLogger } from '@starter/lib/testing';
import { createRateLimitStore } from '#src/infra/rate-limit.ts';
import { isValkeyReachable, openValkey } from '../support/infra.ts';
import { rateLimitStoreContract } from './rate-limit.contract.ts';

const live = await isValkeyReachable();
const valkey = openValkey();
if (live) await valkey.start(AbortSignal.timeout(2000));
afterAll(() => valkey[Symbol.asyncDispose]());

// Each run uses its own prefix, so no bucket outlives the run's keys (they expire with the window).
const prefix = `test:ratelimit:${Bun.randomUUIDv7()}:`;
const store = () =>
	createRateLimitStore(valkey, { prefix, logger: captureLogger().logger, timeoutMs: 1000 });

describe.skipIf(!live)('valkey rate limit store', () => {
	rateLimitStoreContract(
		store,
		(ms) => Bun.sleep(ms),
		() => Bun.randomUUIDv7(),
	);

	test('a Valkey that forgot the script (restart, SCRIPT FLUSH) gets it loaded again', async () => {
		await valkey.command.send('SCRIPT', ['FLUSH']);
		const decision = await store().consume(Bun.randomUUIDv7(), { window: 60, max: 1 });
		expect(decision.allowed).toBe(true);
	});
});

describe('valkey rate limit store, Valkey unreachable', () => {
	test('it fails open: the request passes and a warning says so', async () => {
		const { logger, lines } = captureLogger();
		// Nothing listens here and the client is never started, so the command just waits.
		const dead = openValkey('redis://127.0.0.1:1');
		const limited = createRateLimitStore(dead, { prefix, logger, timeoutMs: 50 });
		const decision = await limited.consume('k', { window: 60, max: 1 });
		expect(decision).toEqual({ allowed: true, retryAfter: null });
		expect(
			lines.some((line) => line['msg'] === 'rate limit unavailable; request let through'),
		).toBe(true);
		await dead[Symbol.asyncDispose]();
	});
});
