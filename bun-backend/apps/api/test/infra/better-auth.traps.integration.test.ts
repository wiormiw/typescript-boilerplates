import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins/bearer';
import { schema, type BunSqlDatabase } from '@starter/db';
import { testUsers } from '../support/auth.ts';
import {
	isMigrated,
	isPostgresReachable,
	openDatabase,
	ownerDatabaseUrl,
} from '../support/infra.ts';

// These pin what better-auth 1.7.18 does on Bun against the real database, as the API's role.
const live = (await isPostgresReachable()) && (await isMigrated(ownerDatabaseUrl));
const maybe = live ? describe : describe.skip;

const users = testUsers('trap');
const { owner } = users;
const databases: BunSqlDatabase[] = [];
const email = () => users.email();

const database = () => {
	const db = openDatabase();
	databases.push(db);
	return db;
};

const { user, session, account, verification } = schema;

const baseOptions = () => ({
	database: drizzleAdapter(database().db, {
		provider: 'pg',
		schema: { user, session, account, verification },
	}),
	basePath: '/auth',
	baseURL: 'http://127.0.0.1:4600',
	secret: 'x'.repeat(32),
	telemetry: { enabled: false },
	// Its warnings (a wrong password, an unknown user) are expected here; keep the run quiet.
	logger: { disabled: true },
	rateLimit: { enabled: false },
	// Without this better-auth makes 32-char ids and Postgres refuses them for a uuid column.
	advanced: { database: { generateId: () => Bun.randomUUIDv7() } },
});

afterEach(() => users.cleanup());
afterAll(async () => {
	await Promise.all(databases.map((db) => db[Symbol.asyncDispose]()));
	await users.close();
});

const rowFor = async (address: string) => {
	const rows = await owner`select * from "user" where email = ${address}`;
	return rows[0];
};

maybe('better-auth on Bun', () => {
	test('(a) generateId stores a version-7 uuid in user.id', async () => {
		const auth = betterAuth({
			...baseOptions(),
			emailAndPassword: { enabled: true },
		});
		const address = email();
		await auth.api.signUpEmail({
			body: { email: address, password: 'correct horse 1', name: 'T' },
		});
		const row = await rowFor(address);
		expect(row?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
	});

	test('(b) Bun.password argon2id hashes and verifies, off the JS thread', async () => {
		const auth = betterAuth({
			...baseOptions(),
			emailAndPassword: {
				enabled: true,
				password: {
					hash: (password) => Bun.password.hash(password, 'argon2id'),
					verify: ({ hash, password }) => Bun.password.verify(password, hash),
				},
			},
		});
		const address = email();
		let ticks = 0;
		const timer = setInterval(() => ticks++, 5);
		try {
			await auth.api.signUpEmail({
				body: { email: address, password: 'correct horse 1', name: 'T' },
			});
		} finally {
			clearInterval(timer);
		}
		expect(ticks).toBeGreaterThanOrEqual(5);
		const rows = await owner`select a.password from account a join "user" u on u.id = a.user_id
			where u.email = ${address}`;
		expect(String(rows[0]?.password)).toStartWith('$argon2id$');
		const signedIn = await auth.api.signInEmail({
			body: { email: address, password: 'correct horse 1' },
		});
		expect(signedIn.user.email).toBe(address);
		await expect(
			auth.api.signInEmail({ body: { email: address, password: 'wrong password 1' } }),
		).rejects.toMatchObject({
			status: 'UNAUTHORIZED',
			statusCode: 401,
			body: { code: 'INVALID_EMAIL_OR_PASSWORD' },
		});
	});

	test('(c) bearer: both the signed header value and the raw body token authenticate getSession', async () => {
		const auth = betterAuth({
			...baseOptions(),
			emailAndPassword: { enabled: true },
			plugins: [bearer()],
		});
		const address = email();
		await auth.api.signUpEmail({
			body: { email: address, password: 'correct horse 1', name: 'T' },
		});
		const response = await auth.api.signInEmail({
			body: { email: address, password: 'correct horse 1' },
			asResponse: true,
		});
		const header = response.headers.get('set-auth-token');
		const body = (await response.json()) as { token?: string };
		expect(header).toBeString();
		// The header carries the signed token (`<token>.<signature>`); the body the raw session token.
		expect(header).toStartWith(`${body.token}.`);
		expect(response.headers.get('set-cookie')).toContain('better-auth.session_token=');
		const found = await auth.api.getSession({
			headers: new Headers({ authorization: `Bearer ${header}` }),
		});
		expect(found?.user.email).toBe(address);
		const raw = await auth.api.getSession({
			headers: new Headers({ authorization: `Bearer ${body.token}` }),
		});
		// The raw token is accepted too: the bearer plugin signs an unsigned value itself.
		expect(raw?.user.email).toBe(address);
	});

	test('(d) disableSignUp rejects signUpEmail with 400 and a stable code', async () => {
		const auth = betterAuth({
			...baseOptions(),
			emailAndPassword: { enabled: true, disableSignUp: true },
		});
		const error = await auth.api
			.signUpEmail({ body: { email: email(), password: 'correct horse 1', name: 'T' } })
			.catch((e: unknown) => e as { statusCode: number; body: { code: string; message: string } });
		expect(error).toMatchObject({
			statusCode: 400,
			body: { code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED' },
		});
	});

	test('(e) requireEmailVerification: 403 before, link verifies through the handler', async () => {
		const sent: { url: string; token: string }[] = [];
		const auth = betterAuth({
			...baseOptions(),
			emailAndPassword: { enabled: true, requireEmailVerification: true },
			emailVerification: {
				sendOnSignUp: true,
				sendVerificationEmail: async ({ url, token }) => {
					sent.push({ url, token });
				},
			},
		});
		const address = email();
		await auth.api.signUpEmail({
			body: { email: address, password: 'correct horse 1', name: 'T' },
		});
		const refused = await auth.api
			.signInEmail({ body: { email: address, password: 'correct horse 1' } })
			.catch((e: unknown) => e as { statusCode: number; body: { code: string } });
		expect(refused).toMatchObject({ statusCode: 403, body: { code: 'EMAIL_NOT_VERIFIED' } });
		// The mail callback is not awaited by sign-up, so give it a moment.
		for (let i = 0; i < 20 && sent.length === 0; i++) await Bun.sleep(25);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.url).toContain('/auth/verify-email?token=');
		const verified = await auth.handler(new Request(sent[0]!.url));
		expect(verified.status).toBe(302);
		expect(verified.headers.get('location')).toBe('/');
		expect(verified.headers.get('set-cookie')).toBeNull();
		expect(
			await owner`select 1 from session s join "user" u on u.id = s.user_id
			where u.email = ${address}`,
		).toHaveLength(0);
		expect((await rowFor(address))?.email_verified).toBe(true);
		const ok = await auth.api.signInEmail({
			body: { email: address, password: 'correct horse 1' },
		});
		expect(ok.user.email).toBe(address);
	});

	test('(e2) a duplicate sign-up with verification required answers 200 with a fake user', async () => {
		const auth = betterAuth({
			...baseOptions(),
			emailAndPassword: { enabled: true, requireEmailVerification: true },
			emailVerification: { sendVerificationEmail: async () => {} },
		});
		const address = email();
		const body = { email: address, password: 'correct horse 1', name: 'T' };
		const first = await auth.api.signUpEmail({ body });
		const again = await auth.api.signUpEmail({ body });
		expect(again.token).toBeNull();
		expect(again.user.id).not.toBe(first.user.id);
		const rows = await owner`select count(*)::int as n from "user" where email = ${address}`;
		expect(rows[0]?.n).toBe(1);
	});

	test('(f) signInSocial returns the Google authorization url and a state cookie', async () => {
		const auth = betterAuth({
			...baseOptions(),
			socialProviders: { google: { clientId: 'dummy', clientSecret: 'dummy' } },
		});
		const response = await auth.api.signInSocial({
			body: { provider: 'google', callbackURL: '/x', disableRedirect: true },
			asResponse: true,
		});
		const body = (await response.json()) as { url: string; redirect: boolean };
		const url = new URL(body.url);
		expect(url.host).toBe('accounts.google.com');
		expect(url.searchParams.get('code_challenge')).toBeString();
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('state')).toBeString();
		expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4600/auth/callback/google');
		expect(body.redirect).toBe(false);
		const cookie = response.headers.get('set-cookie') ?? '';
		expect(cookie).toStartWith('better-auth.state=');
		for (const part of ['Max-Age=300', 'Path=/', 'HttpOnly', 'SameSite=Lax'])
			expect(cookie).toContain(part);
	});

	test('(a2) without generateId a uuid column refuses the id: 422 FAILED_TO_CREATE_USER', async () => {
		const { advanced: _ignored, ...options } = baseOptions();
		const auth = betterAuth({ ...options, emailAndPassword: { enabled: true } });
		const error = await auth.api
			.signUpEmail({ body: { email: email(), password: 'correct horse 1', name: 'T' } })
			.catch((e: unknown) => e as { statusCode: number; body: { code: string } });
		expect(error).toMatchObject({ statusCode: 422, body: { code: 'FAILED_TO_CREATE_USER' } });
	});

	test('(g) socialProviders.google.disableImplicitSignUp is in the types', () => {
		const options = {
			...baseOptions(),
			socialProviders: {
				google: { clientId: 'dummy', clientSecret: 'dummy', disableImplicitSignUp: true },
			},
		};
		expect(betterAuth(options).options.socialProviders?.google?.disableImplicitSignUp).toBe(true);
	});

	test('(h0) deleting the user row cascades session, account and user_settings by FK', async () => {
		const auth = betterAuth({ ...baseOptions(), emailAndPassword: { enabled: true } });
		const address = email();
		await auth.api.signUpEmail({
			body: { email: address, password: 'correct horse 1', name: 'T' },
		});
		await auth.api.signInEmail({ body: { email: address, password: 'correct horse 1' } });
		const id = (await rowFor(address))!.id as string;
		await owner`insert into user_settings (user_id) values (${id})`;
		const count = async (table: string) =>
			Number(
				(await owner`select count(*)::int as n from ${owner(table)} where user_id = ${id}`)[0]?.n,
			);
		expect(await count('session')).toBe(2); // sign-up opens one when verification is off
		expect(await count('account')).toBe(1);
		expect(await count('user_settings')).toBe(1);
		await owner`delete from "user" where id = ${id}`;
		expect(await count('session')).toBe(0);
		expect(await count('account')).toBe(0);
		expect(await count('user_settings')).toBe(0);
	});

	test('(h) deleteUser calls beforeDelete once and leaves no session, account, user_settings rows', async () => {
		let before = 0;
		const auth = betterAuth({
			...baseOptions(),
			emailAndPassword: { enabled: true },
			user: {
				deleteUser: {
					enabled: true,
					beforeDelete: async () => {
						before++;
					},
				},
			},
			plugins: [bearer()],
		});
		const address = email();
		await auth.api.signUpEmail({
			body: { email: address, password: 'correct horse 1', name: 'T' },
		});
		const response = await auth.api.signInEmail({
			body: { email: address, password: 'correct horse 1' },
			asResponse: true,
		});
		const token = response.headers.get('set-auth-token')!;
		const id = (await rowFor(address))!.id as string;
		await owner`insert into user_settings (user_id) values (${id})`;
		await auth.api.deleteUser({
			body: { password: 'correct horse 1' },
			headers: new Headers({ authorization: `Bearer ${token}` }),
		});
		expect(before).toBe(1);
		const count = async (table: string, column: string) =>
			Number(
				(
					await owner`select count(*)::int as n from ${owner(table)} where ${owner(column)} = ${id}`
				)[0]?.n,
			);
		expect(await rowFor(address)).toBeUndefined();
		expect(await count('session', 'user_id')).toBe(0);
		expect(await count('account', 'user_id')).toBe(0);
		expect(await count('user_settings', 'user_id')).toBe(0);
	});

	test('(i) revokeSessions deletes every session; their bearer tokens then get null', async () => {
		const auth = betterAuth({
			...baseOptions(),
			emailAndPassword: { enabled: true },
			plugins: [bearer()],
		});
		const address = email();
		await auth.api.signUpEmail({
			body: { email: address, password: 'correct horse 1', name: 'T' },
		});
		const signIn = async () =>
			(
				await auth.api.signInEmail({
					body: { email: address, password: 'correct horse 1' },
					asResponse: true,
				})
			).headers.get('set-auth-token')!;
		const first = await signIn();
		const second = await signIn();
		const headers = (token: string) => new Headers({ authorization: `Bearer ${token}` });
		expect(await auth.api.getSession({ headers: headers(first) })).not.toBeNull();
		await auth.api.revokeSessions({ headers: headers(first) });
		expect(await auth.api.getSession({ headers: headers(first) })).toBeNull();
		expect(await auth.api.getSession({ headers: headers(second) })).toBeNull();
	});
});
