import { describe } from 'bun:test';
import { mutableClock } from '@starter/lib/time';
import { memoryRateLimit } from '../support/rate-limit.ts';
import { rateLimitStoreContract } from './rate-limit.contract.ts';

describe('memory rate limit store', () => {
	const clock = mutableClock('2026-01-01T00:00:00Z');
	rateLimitStoreContract(
		() => memoryRateLimit(clock),
		async (ms) => clock.advance({ milliseconds: ms }),
		() => Bun.randomUUIDv7(),
	);
});
