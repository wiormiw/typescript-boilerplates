import { describe, expect, test } from 'bun:test';
import { createAuthenticate } from '#src/infra/auth.ts';
import type { Auth } from '#src/infra/types.ts';

const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const headers = new Headers({ authorization: 'Bearer t' });

/** An auth whose getSession answers `answer`; the full better-auth type is nominal, so cast. */
function authAnswering(answer: () => Promise<unknown>): Pick<Auth, 'api'> {
	return { api: { getSession: answer } } as unknown as Pick<Auth, 'api'>;
}

const found = (user: Record<string, unknown>) => async () => ({
	user: { id: ID, email: 'a@example.com', name: 'A', emailVerified: true, ...user },
	session: { id: 's1', token: 'secret' },
});

describe('createAuthenticate', () => {
	test('null becomes undefined', async () => {
		const authenticate = createAuthenticate(authAnswering(async () => null));
		expect(await authenticate(headers, new AbortController().signal)).toBeUndefined();
	});

	test('a valid user becomes the exact AuthenticatedSession, without extra fields', async () => {
		const authenticate = createAuthenticate(
			authAnswering(found({ image: 'x.png', createdAt: new Date() })),
		);
		expect(await authenticate(headers, new AbortController().signal)).toEqual({
			user: { id: ID, email: 'a@example.com', name: 'A', emailVerified: true },
			sessionId: 's1',
		});
	});

	test('a user that breaks the contract throws', async () => {
		const authenticate = createAuthenticate(authAnswering(found({ id: 'not-a-uuid' })));
		await expect(authenticate(headers, new AbortController().signal)).rejects.toThrow();
	});

	test('an aborted signal rejects with its reason without waiting for getSession', async () => {
		const authenticate = createAuthenticate(authAnswering(() => new Promise(() => {})));
		const controller = new AbortController();
		const reason = new Error('gone');
		controller.abort(reason);
		await expect(authenticate(headers, controller.signal)).rejects.toBe(reason);
	});
});
