import { describe } from 'bun:test';
import { mutableClock } from '@starter/lib/time';
import { memoryAuthCodes } from '../support/auth-codes.ts';
import { authCodeStoreContract } from './auth-codes.contract.ts';

describe('memory auth code store', () => {
	const clock = mutableClock('2026-01-01T00:00:00Z');
	authCodeStoreContract(
		() => memoryAuthCodes(clock),
		async (ms) => clock.advance({ milliseconds: ms }),
		() => Bun.randomUUIDv7(),
	);
});
