import { afterAll, describe } from 'bun:test';
import { createAuthCodeStore } from '#src/infra/auth-codes.ts';
import { isValkeyReachable, openValkey } from '../support/infra.ts';
import { authCodeStoreContract } from './auth-codes.contract.ts';

const live = await isValkeyReachable();
const valkey = openValkey();
if (live) await valkey.start(AbortSignal.timeout(2000));
afterAll(() => valkey[Symbol.asyncDispose]());

describe.skipIf(!live)('valkey auth code store', () => {
	authCodeStoreContract(
		() => createAuthCodeStore(valkey),
		(ms) => Bun.sleep(ms),
		() => `test-${Bun.randomUUIDv7()}`,
	);
});
