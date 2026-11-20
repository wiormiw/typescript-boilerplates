import { expect, test } from 'bun:test';
import type { AuthCodeStore, NativeFlow, NativeGrant } from '#src/infra/types.ts';

const flow: NativeFlow = {
	codeChallenge: 'c',
	redirectUri: 'starter://auth/callback',
	clientState: 's',
};
const grant: NativeGrant = { sessionToken: 't.sig', codeChallenge: 'c', userId: 'u' };
const signal = () => AbortSignal.timeout(5000);

/** The contract every AuthCodeStore keeps; `wait` moves time (real or fake) past a TTL. */
export function authCodeStoreContract(
	make: () => AuthCodeStore,
	wait: (ms: number) => Promise<void>,
	id: () => string,
) {
	test('takeCode returns the grant once, then undefined', async () => {
		const store = make();
		const code = id();
		await store.putCode(code, grant, 60, signal());
		expect(await store.takeCode(code, signal())).toEqual(grant);
		expect(await store.takeCode(code, signal())).toBeUndefined();
	});

	test('takeFlow returns the flow once, then undefined', async () => {
		const store = make();
		const key = id();
		await store.putFlow(key, flow, 60, signal());
		expect(await store.takeFlow(key, signal())).toEqual(flow);
		expect(await store.takeFlow(key, signal())).toBeUndefined();
	});

	test('a TTL of 1 s is gone after 1.1 s', async () => {
		const store = make();
		const code = id();
		await store.putCode(code, grant, 1, signal());
		await wait(1100);
		expect(await store.takeCode(code, signal())).toBeUndefined();
	});

	test('a flow and a code with the same name do not collide', async () => {
		const store = make();
		const key = id();
		await store.putFlow(key, flow, 60, signal());
		await store.putCode(key, grant, 60, signal());
		expect(await store.takeCode(key, signal())).toEqual(grant);
		expect(await store.takeFlow(key, signal())).toEqual(flow);
	});

	test('two concurrent takes: exactly one wins', async () => {
		const store = make();
		const code = id();
		await store.putCode(code, grant, 60, signal());
		const results = await Promise.all([
			store.takeCode(code, signal()),
			store.takeCode(code, signal()),
		]);
		expect(results.filter((r) => r !== undefined)).toHaveLength(1);
	});
}
