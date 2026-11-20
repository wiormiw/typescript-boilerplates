import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { MeView, ProblemView, SettingsView } from '@starter/contracts';
import { Lifecycle } from '@starter/lib/lifecycle';
import { silentLogger } from '@starter/lib/log';
import { captureLogger } from '@starter/lib/testing';
import { createApp } from '#src/bootstrap/app.ts';
import { createAuthModule } from '#src/modules/auth/auth.module.ts';
import type { AuthModuleDeps } from '#src/modules/auth/auth.types.ts';
import type { AuthenticatedSession } from '#src/shared/http/types.ts';
import { database, insertUser, live } from './support.ts';
import { schema, type Tx } from '@starter/db';
import { withRollback } from '@starter/db/testing';
import { sql } from 'drizzle-orm';
import { httpLimits } from '../../support/app.ts';

const USER_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const session: AuthenticatedSession = {
	user: { id: USER_ID, email: 'a@example.com', name: 'A', emailVerified: true },
	sessionId: 's1',
};

interface FakeAuth {
	handler?: (request: Request) => Promise<Response>;
	revokeSessions?: (options: { headers: Headers }) => Promise<unknown>;
	deleteUser?: (options: { body: { password?: string }; headers: Headers }) => Promise<unknown>;
}

/** The app over the auth module, a fake better-auth, and a database that must not be reached. */
function build(fake: FakeAuth = {}, signedIn: AuthenticatedSession | null = session) {
	const { logger, lines } = captureLogger();
	const lifecycle = new Lifecycle(logger);
	lifecycle.markReady();
	const unreachable = new Proxy(
		{},
		{
			get: () => {
				throw new Error('database reached');
			},
		},
	);
	const deps = {
		auth: {
			handler: fake.handler ?? (async () => new Response('{}')),
			api: { revokeSessions: fake.revokeSessions, deleteUser: fake.deleteUser },
		},
		database: { db: unreachable, control: unreachable },
		logger,
	} as unknown as AuthModuleDeps;
	return {
		app: createApp({
			logger,
			lifecycle,
			modules: [createAuthModule(deps)],
			authenticate: async () => signedIn ?? undefined,
			...httpLimits,
			debugRoutes: false,
		}),
		lines,
	};
}

const bearer = { authorization: 'Bearer t', 'content-type': 'application/json' };
// A request with no body carries no content type: an empty body labelled JSON is malformed JSON.
const bearerOnly = { authorization: 'Bearer t' };
const problem = async (res: Response) => v.parse(ProblemView, await res.json());

describe('auth router', () => {
	test('PATCH /me/settings with an unknown time zone is a 400 validation problem', async () => {
		const { app } = build();
		const res = await app.request('/me/settings', {
			method: 'PATCH',
			headers: bearer,
			body: JSON.stringify({ timezone: 'Mars/Base' }),
		});
		expect(res.status).toBe(400);
		expect((await problem(res)).code).toBe('common.request.validation_failed');
	});

	test('PATCH /me/settings with {} or an unknown key or bad JSON is a 400', async () => {
		const { app } = build();
		for (const body of ['{}', '{"nope":1}', '{bad']) {
			const res = await app.request('/me/settings', { method: 'PATCH', headers: bearer, body });
			expect(res.status).toBe(400);
		}
	});

	test('without a session GET /me, PATCH /me/settings and DELETE /me are 401', async () => {
		const { app } = build({}, null);
		for (const [method, path] of [
			['GET', '/me'],
			['PATCH', '/me/settings'],
			['DELETE', '/me'],
			['DELETE', '/me/sessions'],
		] as const) {
			const res = await app.request(path, {
				method,
				headers: bearer,
				body: method === 'PATCH' ? '{"llmEnabled":true}' : undefined,
			});
			expect(res.status).toBe(401);
		}
	});

	test('the catch-all turns a better-auth error into problem+json with the code as reason', async () => {
		const { app } = build({
			handler: async () =>
				Response.json({ code: 'USER_ALREADY_EXISTS', message: 'exists' }, { status: 400 }),
		});
		const res = await app.request('/auth/sign-up/email', { method: 'POST', body: '{}' });
		expect(res.status).toBe(400);
		expect(res.headers.get('content-type')).toContain('application/problem+json');
		const body = await problem(res);
		expect(body.code).toBe('common.request.validation_failed');
		expect(body.details).toEqual({ reason: 'USER_ALREADY_EXISTS' });
	});

	test.each([
		[401, 'auth.session.unauthenticated'],
		[403, 'common.auth.forbidden'],
		[422, 'common.request.validation_failed'],
		[429, 'common.request.rate_limited'],
		[500, 'common.server.unexpected'],
		[404, 'common.route.not_found'],
	])('the catch-all maps better-auth %i to %s', async (status, code) => {
		const { app } = build({
			handler: async () => Response.json({ code: 'X', message: 'm' }, { status }),
		});
		const res = await app.request('/auth/anything');
		// ValidationFailed is a 400 whichever status better-auth used.
		expect(res.status).toBe(status === 422 ? 400 : status);
		expect((await problem(res)).code).toBe(code);
	});

	test('a better-auth 5xx is logged with its reason code, never its body', async () => {
		const { app, lines } = build({
			handler: async () =>
				Response.json(
					{ code: 'FAILED_TO_CREATE_SESSION', message: 'secret detail' },
					{ status: 500 },
				),
		});
		expect((await app.request('/auth/sign-in/email')).status).toBe(500);
		const logged = lines.filter((line) => line['msg'] === 'better-auth failed');
		expect(logged).toHaveLength(1);
		expect(logged[0]).toMatchObject({ status: 500, reason: 'FAILED_TO_CREATE_SESSION' });
		expect(JSON.stringify(lines)).not.toContain('secret detail');
	});

	test('a better-auth 4xx is the API working: no error line', async () => {
		const { app, lines } = build({
			handler: async () => Response.json({ code: 'X' }, { status: 401 }),
		});
		await app.request('/auth/sign-in/email');
		expect(lines.some((line) => line['msg'] === 'better-auth failed')).toBe(false);
	});

	test('a 429 keeps better-auth Retry-After', async () => {
		const { app } = build({
			handler: async () =>
				Response.json({ message: 'slow' }, { status: 429, headers: { 'retry-after': '12' } }),
		});
		const res = await app.request('/auth/sign-in/email', { method: 'POST' });
		expect(res.headers.get('retry-after')).toBe('12');
	});

	test('a 2xx keeps both set-cookie headers', async () => {
		const { app } = build({
			handler: async () => {
				const headers = new Headers();
				headers.append('set-cookie', 'a=1; Path=/');
				headers.append('set-cookie', 'b=2; Path=/');
				return new Response('{"ok":true}', { status: 200, headers });
			},
		});
		const res = await app.request('/auth/sign-in/email', { method: 'POST' });
		expect(res.status).toBe(200);
		expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
	});

	test('a redirect passes through untouched', async () => {
		const { app } = build({
			handler: async () => new Response(null, { status: 302, headers: { location: '/x' } }),
		});
		const res = await app.request('/auth/verify-email?token=t');
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/x');
	});

	test('DELETE /me with a wrong password is a 400 problem, not a bare error', async () => {
		const { app } = build({
			deleteUser: async () => {
				const { APIError } = await import('better-auth/api');
				throw new APIError('BAD_REQUEST', {
					message: 'Invalid password',
					code: 'INVALID_PASSWORD',
				});
			},
		});
		const res = await app.request('/me', {
			method: 'DELETE',
			headers: bearer,
			body: JSON.stringify({ password: 'nope' }),
		});
		expect(res.status).toBe(400);
		const body = await problem(res);
		expect(body.code).toBe('common.request.validation_failed');
		expect(body.details).toEqual({ reason: 'INVALID_PASSWORD' });
	});

	test('DELETE /me passes the password and answers 204', async () => {
		let seen: string | undefined;
		const { app } = build({
			deleteUser: async (options) => {
				seen = options.body.password;
				return { success: true };
			},
		});
		const res = await app.request('/me', {
			method: 'DELETE',
			headers: bearer,
			body: JSON.stringify({ password: 'hunter2' }),
		});
		expect(res.status).toBe(204);
		expect(seen).toBe('hunter2');
	});

	test('revokeSessions throwing a 401 APIError is a problem+json 401', async () => {
		const { app } = build({
			revokeSessions: async () => {
				const { APIError } = await import('better-auth/api');
				throw new APIError('UNAUTHORIZED', { message: 'no', code: 'UNAUTHORIZED' });
			},
		});
		const res = await app.request('/me/sessions', { method: 'DELETE', headers: bearer });
		expect(res.status).toBe(401);
		expect((await problem(res)).code).toBe('auth.session.unauthenticated');
	});
});

/** The app over a fake better-auth and a transaction the test owns, signed in as `id`. */
function dbApp(tx: Tx, id: string, fake: FakeAuth) {
	const { logger } = captureLogger();
	const lifecycle = new Lifecycle(logger);
	lifecycle.markReady();
	const deps = {
		auth: {
			handler: async () => new Response('{}'),
			api: { revokeSessions: fake.revokeSessions, deleteUser: fake.deleteUser },
		},
		database: { db: tx, control: database.control },
		logger: silentLogger(),
	} as unknown as AuthModuleDeps;
	const user = { id, email: `${id}@example.test`, name: 'T', emailVerified: true };
	return createApp({
		logger,
		lifecycle,
		modules: [createAuthModule(deps)],
		authenticate: async () => ({ user, sessionId: 's' }),
		...httpLimits,
		debugRoutes: false,
	});
}

const maybe = live ? describe : describe.skip;

maybe('auth router over the database', () => {
	test('GET /me and PATCH /me/settings answer the views; sign-out-everywhere writes the audit row', async () => {
		await withRollback(database.db, async (tx) => {
			const id = await insertUser(tx);
			const { logger } = captureLogger();
			const lifecycle = new Lifecycle(logger);
			lifecycle.markReady();
			let revoked = 0;
			const deps = {
				auth: {
					handler: async () => new Response('{}'),
					api: { revokeSessions: async () => void revoked++, deleteUser: async () => ({}) },
				},
				database: { db: tx, control: database.control },
				logger: silentLogger(),
			} as unknown as AuthModuleDeps;
			const user = { id, email: `${id}@example.test`, name: 'T', emailVerified: true };
			const app = createApp({
				logger,
				lifecycle,
				modules: [createAuthModule(deps)],
				authenticate: async () => ({ user, sessionId: 's' }),
				...httpLimits,
				debugRoutes: false,
			});
			const me = await app.request('/me', { headers: bearer });
			expect(me.status).toBe(200);
			expect(v.parse(MeView, await me.json()).settings.timezone).toBe('Asia/Jakarta');

			const patched = await app.request('/me/settings', {
				method: 'PATCH',
				headers: bearer,
				body: JSON.stringify({ emailReminders: false }),
			});
			expect(patched.status).toBe(200);
			expect(v.parse(SettingsView, await patched.json()).emailReminders).toBe(false);

			const out = await app.request('/me/sessions', { method: 'DELETE', headers: bearer });
			expect(out.status).toBe(204);
			expect(revoked).toBe(1);
			const rows = await tx.execute<{ action: string }>(
				sql`select action from audit where user_id = ${id}`,
			);
			expect(rows.map((r) => r.action)).toEqual(['sign_out_everywhere']);
		});
	});

	test('DELETE /me/sessions revokes once, before the audit row is written, and answers 204', async () => {
		await withRollback(database.db, async (tx) => {
			const id = await insertUser(tx);
			const auditedAtRevoke: number[] = [];
			const app = dbApp(tx, id, {
				revokeSessions: async () => {
					const rows = await tx.execute(sql`select 1 from audit where user_id = ${id}`);
					auditedAtRevoke.push(rows.length);
					return { status: true };
				},
			});
			const res = await app.request('/me/sessions', { method: 'DELETE', headers: bearer });
			expect(res.status).toBe(204);
			expect(auditedAtRevoke).toEqual([0]);
		});
	});

	test('DELETE /me without a password is refused for a password account and never reaches better-auth', async () => {
		await withRollback(database.db, async (tx) => {
			const id = await insertUser(tx);
			await tx.insert(schema.account).values({
				id: Bun.randomUUIDv7(),
				accountId: id,
				providerId: 'credential',
				userId: id,
				password: 'x',
			});
			let called = 0;
			const app = dbApp(tx, id, {
				deleteUser: async () => {
					called++;
					return { success: true };
				},
			});
			const res = await app.request('/me', { method: 'DELETE', headers: bearerOnly });
			expect(res.status).toBe(400);
			const body = await problem(res);
			expect(body.code).toBe('common.request.validation_failed');
			expect(body.details).toEqual({ reason: 'PASSWORD_REQUIRED' });
			expect(called).toBe(0);
		});
	});

	test('DELETE /me without a password reaches better-auth for a user with no password login', async () => {
		await withRollback(database.db, async (tx) => {
			const id = await insertUser(tx);
			await tx.insert(schema.account).values({
				id: Bun.randomUUIDv7(),
				accountId: 'g',
				providerId: 'google',
				userId: id,
			});
			let called = 0;
			const app = dbApp(tx, id, {
				deleteUser: async () => {
					called++;
					return { success: true };
				},
			});
			const res = await app.request('/me', { method: 'DELETE', headers: bearerOnly });
			expect(res.status).toBe(204);
			expect(called).toBe(1);
		});
	});
});
