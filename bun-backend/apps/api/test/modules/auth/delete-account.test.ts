import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { silentLogger } from '@starter/lib/log';
import { deleteAccount } from '#src/modules/auth/use-cases/delete-account.ts';
import { testAuth, testUsers } from '../../support/auth.ts';
import { openDatabase } from '../../support/infra.ts';
import { live } from './support.ts';

const maybe = live ? describe : describe.skip;

const users = testUsers('del');
const { owner } = users;
const password = 'correct horse 1';
const db = openDatabase();
const { auth } = testAuth({ database: db });
const deps = { auth, database: db, logger: silentLogger() };

afterEach(() => users.cleanup());
afterAll(async () => {
	await db[Symbol.asyncDispose]();
	await users.close();
});

/** A verified password account, signed in: its id and a bearer header. */
async function signedIn() {
	const email = users.email();
	await auth.api.signUpEmail({ body: { email, password, name: 'T' } });
	await owner`update "user" set email_verified = true where email = ${email}`;
	// Looked up (and so tracked) now: once deleted, its audit row can't be found by email.
	const id = (await users.idOf(email)) as string;
	const response = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
	const headers = new Headers({
		authorization: `Bearer ${response.headers.get('set-auth-token')}`,
	});
	return { id, email, headers };
}

const exists = async (email: string) =>
	(await owner`select 1 from "user" where email = ${email}`).length === 1;
const signal = () => AbortSignal.timeout(10_000);

maybe('deleteAccount over a real better-auth', () => {
	test('a password account without a password is refused and the user remains', async () => {
		const { id, email, headers } = await signedIn();
		const result = await deleteAccount(deps, { userId: id, headers }, signal());
		expect(!result.ok && result.error.details).toEqual({ reason: 'PASSWORD_REQUIRED' });
		expect(await exists(email)).toBe(true);
	});

	test('the right password deletes the user', async () => {
		const { id, email, headers } = await signedIn();
		const result = await deleteAccount(deps, { userId: id, headers, password }, signal());
		expect(result.ok).toBe(true);
		expect(await exists(email)).toBe(false);
	});

	test('a wrong password is a validation problem and the user remains', async () => {
		const { id, email, headers } = await signedIn();
		const result = await deleteAccount(deps, { userId: id, headers, password: 'nope' }, signal());
		expect(!result.ok && result.error.kind).toBe('validation');
		expect(await exists(email)).toBe(true);
	});
});
