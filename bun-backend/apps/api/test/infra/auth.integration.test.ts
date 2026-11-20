import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { asUser, audit, userSettings, type BunSqlDatabase } from '@starter/db';
import { silentLogger } from '@starter/lib/log';
import { ok } from '@starter/lib/result';
import { captureLogger } from '@starter/lib/testing';
import { CLIENT_ADDRESS_HEADER } from '#src/shared/http/client-address.ts';
import { authEnv, testAuth, testUsers } from '../support/auth.ts';
import {
	isMigrated,
	isPostgresReachable,
	openDatabase,
	ownerDatabaseUrl,
} from '../support/infra.ts';

const live = (await isPostgresReachable()) && (await isMigrated(ownerDatabaseUrl));
const maybe = live ? describe : describe.skip;

const users = testUsers('auth');
const { owner } = users;
const email = () => users.email();
// Asked of users that exist; after a deletion it is undefined, which the test checks.
const userId = async (address: string) => (await users.idOf(address)) as string;
const databases: BunSqlDatabase[] = [];
const shutdown = new AbortController();

const database = () => {
	const db = openDatabase();
	databases.push(db);
	return db;
};

function build(env: Parameters<typeof authEnv>[0] = {}, logger = silentLogger()) {
	const db = database();
	return { db, ...testAuth({ database: db, env, logger, shutdown: shutdown.signal }) };
}

afterEach(() => users.cleanup());
afterAll(async () => {
	await Promise.all(databases.map((db) => db[Symbol.asyncDispose]()));
	await users.close();
});

const password = 'correct horse 1';

/** Sign-up, then verify by hand (the mail is a log line), so a sign-in is allowed. */
async function registered(auth: ReturnType<typeof build>['auth'], address: string) {
	await auth.api.signUpEmail({ body: { email: address, password, name: 'T' } });
	await owner`update "user" set email_verified = true where email = ${address}`;
	return userId(address);
}

maybe('createAuth', () => {
	test('sign-up creates the user_settings row with the default timezone', async () => {
		const { auth, db } = build();
		const address = email();
		await auth.api.signUpEmail({ body: { email: address, password, name: 'T' } });
		const id = await userId(address);
		const rows = await asUser(
			db,
			{ userId: id, signal: AbortSignal.timeout(5000), operation: 'test.settings' },
			async (tx) => ok(await tx.select().from(userSettings)),
		);
		expect(rows.ok && rows.value.map((r) => [r.userId, r.timezone])).toEqual([
			[id, 'Asia/Jakarta'],
		]);
	});

	test('sign-up sends the verification link through the mailer', async () => {
		const { auth, mail } = build();
		const address = email();
		await auth.api.signUpEmail({ body: { email: address, password, name: 'T' } });
		for (let i = 0; i < 20 && mail.length === 0; i++) await Bun.sleep(25);
		expect(mail).toHaveLength(1);
		expect(mail[0]?.to).toBe(address);
		expect(mail[0]?.text).toContain('/auth/verify-email?token=');
	});

	test('sign-in is refused until the email is verified', async () => {
		const { auth } = build();
		const address = email();
		await auth.api.signUpEmail({ body: { email: address, password, name: 'T' } });
		await expect(
			auth.api.signInEmail({ body: { email: address, password } }),
		).rejects.toMatchObject({ statusCode: 403, body: { code: 'EMAIL_NOT_VERIFIED' } });
	});

	test('a session writes one sign_in audit row, visible only to its owner', async () => {
		const { auth, db } = build();
		const address = email();
		const id = await registered(auth, address);
		await auth.api.signInEmail({
			body: { email: address, password },
			// The address the router sets from the socket; a client's x-forwarded-for is ignored.
			headers: new Headers({
				'user-agent': 'auth-test/1',
				[CLIENT_ADDRESS_HEADER]: '203.0.113.9',
				'x-forwarded-for': '198.51.100.66',
			}),
		});
		const read = (who: string) =>
			asUser(
				db,
				{ userId: who, signal: AbortSignal.timeout(5000), operation: 'test.audit' },
				async (tx) => ok(await tx.select().from(audit)),
			);
		const mine = await read(id);
		expect(mine.ok && mine.value).toHaveLength(1);
		expect(mine.ok && mine.value[0]).toMatchObject({
			userId: id,
			action: 'sign_in',
			userAgent: 'auth-test/1',
			ip: '203.0.113.9',
		});
		const theirs = await read(Bun.randomUUIDv7());
		expect(theirs.ok && theirs.value).toHaveLength(0);
	});

	test('deleting the account keeps one account_deleted row without IP or user agent', async () => {
		const { auth } = build();
		const address = email();
		const id = await registered(auth, address);
		const response = await auth.api.signInEmail({
			body: { email: address, password },
			headers: new Headers({ 'user-agent': 'auth-test/1', [CLIENT_ADDRESS_HEADER]: '203.0.113.9' }),
			asResponse: true,
		});
		const token = response.headers.get('set-auth-token')!;
		await auth.api.deleteUser({
			body: { password },
			headers: new Headers({ authorization: `Bearer ${token}` }),
		});
		expect(await userId(address)).toBeUndefined();
		const rows = await owner`select action, ip, user_agent from audit where user_id = ${id}`;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ action: 'account_deleted', ip: null, user_agent: null });
		await owner`delete from audit where user_id = ${id}`;
	});

	test('with sign-up closed, Google may not create users either', () => {
		const { auth } = build({
			SIGNUP_ENABLED: false,
			GOOGLE_CLIENT_ID: 'id',
			GOOGLE_CLIENT_SECRET: 'secret',
		});
		// disableImplicitSignUp alone is overridden by a client's requestSignUp: true.
		expect(auth.options.socialProviders?.google?.disableImplicitSignUp).toBe(true);
		expect(auth.options.socialProviders?.google?.disableSignUp).toBe(true);
		expect(auth.options.emailAndPassword?.disableSignUp).toBe(true);
	});

	test('with sign-up open, Google may create users', () => {
		const { auth } = build({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' });
		expect(auth.options.socialProviders?.google?.disableImplicitSignUp).toBe(false);
		expect(auth.options.socialProviders?.google?.disableSignUp).toBe(false);
	});

	test('Google is absent when it is not configured', () => {
		expect(build().auth.options.socialProviders?.google).toBeUndefined();
	});

	test('a failing hook is logged with the user id only and fails the operation', async () => {
		const { logger, lines } = captureLogger();
		const aborted = new AbortController();
		aborted.abort(new Error('shutting down: test'));
		const { auth } = testAuth({ database: database(), logger, shutdown: aborted.signal });
		const address = email();
		await expect(
			auth.api.signUpEmail({ body: { email: address, password, name: 'T' } }),
		).rejects.toBeDefined();
		const failure = lines.find((l) => l['msg'] === 'auth hook failed');
		expect(failure).toMatchObject({ hook: 'user.create.after' });
		expect(failure?.['userId']).toBeString();
		expect(JSON.stringify(lines)).not.toContain(address);
		// The hook runs after the insert, so the user stays, without a settings row (Task 8 creates
		// it lazily).
		const id = await userId(address);
		expect(id).toBeString();
		expect(await owner`select 1 from user_settings where user_id = ${id}`).toHaveLength(0);
	});
});
