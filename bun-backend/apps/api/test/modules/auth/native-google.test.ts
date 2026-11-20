import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { ProblemView, SessionTokenView } from '@starter/contracts';
import { Lifecycle } from '@starter/lib/lifecycle';
import { mutableClock } from '@starter/lib/time';
import { captureLogger } from '@starter/lib/testing';
import { createApp } from '#src/bootstrap/app.ts';
import { createAuthModule } from '#src/modules/auth/auth.module.ts';
import type { AuthModuleDeps } from '#src/modules/auth/auth.types.ts';
import { challengeOf } from '#src/modules/auth/use-cases/exchange-native-code.ts';
import { memoryAuthCodes } from '../../support/auth-codes.ts';
import { httpLimits } from '../../support/app.ts';
import { defaults } from '../../support/env.ts';

const REDIRECT = 'starter://auth/callback';
const USER = {
	id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
	email: 'a@example.com',
	name: 'A',
	emailVerified: true,
	image: null,
};
const SIGNED = 'rawtoken.sig/with+chars=';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

/** A fake better-auth: Google configured or not, and one live session reached by cookie or bearer. */
function build(options: { google?: boolean } = {}) {
	const { google = true } = options;
	const { logger, lines } = captureLogger();
	const lifecycle = new Lifecycle(logger);
	lifecycle.markReady();
	const calls: unknown[] = [];
	const deps = {
		auth: {
			handler: async () => new Response('{}'),
			// What names the session cookie; plain http, so no __Secure- prefix.
			options: { baseURL: 'http://127.0.0.1:4600' },
			api: {
				signInSocial: async (args: unknown) => {
					calls.push(args);
					if (!google) {
						return Response.json({ code: 'PROVIDER_NOT_FOUND' }, { status: 404 });
					}
					return new Response(
						JSON.stringify({
							url: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
							redirect: false,
						}),
						{
							headers: {
								'content-type': 'application/json',
								'set-cookie': 'better-auth.state=abc; Max-Age=300; Path=/; HttpOnly; SameSite=Lax',
							},
						},
					);
				},
				getSession: async ({ headers }: { headers: Headers }) => {
					const cookie = headers.get('cookie') ?? '';
					const bearer = headers.get('authorization');
					const viaCookie = cookie.includes(
						`better-auth.session_token=${encodeURIComponent(SIGNED)}`,
					);
					const viaBearer = bearer === `Bearer ${SIGNED}`;
					return viaCookie || viaBearer ? { user: USER, session: { id: 's' } } : null;
				},
			},
		},
		database: {},
		logger,
		authCodes: memoryAuthCodes(mutableClock('2026-01-01T00:00:00Z')),
		redirectUris: [REDIRECT],
		flowTtlS: defaults.NATIVE_FLOW_TTL_S,
		codeTtlS: defaults.NATIVE_CODE_TTL_S,
	} as unknown as AuthModuleDeps;
	const app = createApp({
		logger,
		lifecycle,
		modules: [createAuthModule(deps)],
		authenticate: async () => undefined,
		...httpLimits,
		debugRoutes: false,
	});
	return { app, lines, calls, deps };
}

const startUrl = (overrides: Record<string, string> = {}) => {
	const query = new URLSearchParams({
		code_challenge: CHALLENGE,
		code_challenge_method: 'S256',
		redirect_uri: REDIRECT,
		state: 'client state&x=1',
		...overrides,
	});
	return `/auth/native/google/start?${query}`;
};

const problem = async (res: Response) => v.parse(ProblemView, await res.json());
const callbackUrl = (calls: unknown[]) =>
	(calls[0] as { body: { callbackURL: string } }).body.callbackURL;

/** Runs start and returns the flow id better-auth was told to come back with. */
async function started(app: ReturnType<typeof build>['app'], calls: unknown[]) {
	const res = await app.request(startUrl());
	expect(res.status).toBe(302);
	return new URL(callbackUrl(calls), 'http://x').searchParams.get('flow') ?? '';
}

const finish = (app: ReturnType<typeof build>['app'], flow: string, signedIn = true) =>
	app.request(`/auth/native/google/finish?flow=${flow}`, {
		headers: signedIn ? { cookie: `better-auth.session_token=${encodeURIComponent(SIGNED)}` } : {},
	});

const exchange = (app: ReturnType<typeof build>['app'], code: string, verifier: string) =>
	app.request('/auth/native/exchange', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ code, code_verifier: verifier }),
	});

/** Finishes a flow and returns the code and state the client would receive. */
async function signedIn(app: ReturnType<typeof build>['app'], calls: unknown[]) {
	const res = await finish(app, await started(app, calls));
	expect(res.status).toBe(302);
	const location = new URL(res.headers.get('location') ?? '');
	return { res, location, code: location.searchParams.get('code') ?? '' };
}

describe('PKCE', () => {
	test('the RFC 7636 appendix B vector', () => {
		expect(challengeOf(VERIFIER)).toBe(CHALLENGE);
	});
});

describe('GET /auth/native/google/start', () => {
	test('an unlisted redirect_uri is a 400 with no location', async () => {
		const { app, calls } = build();
		for (const redirect of [
			'https://evil.example/cb',
			`${REDIRECT}/`,
			`${REDIRECT}?x=1`,
			'STARTER://auth/callback',
		]) {
			const res = await app.request(startUrl({ redirect_uri: redirect }));
			expect(res.status).toBe(400);
			expect(res.headers.get('location')).toBeNull();
			expect((await problem(res)).code).toBe('auth.native.redirect_not_allowed');
		}
		expect(calls).toHaveLength(0);
	});

	test('a valid start is a 302 to Google that keeps the state cookie and the request id', async () => {
		const { app, calls } = build();
		const res = await app.request(startUrl());
		expect(res.status).toBe(302);
		expect(new URL(res.headers.get('location') ?? '').host).toBe('accounts.google.com');
		expect(res.headers.getSetCookie().join('\n')).toContain('better-auth.state=abc');
		expect(res.headers.get('x-request-id')).toBeString();
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(callbackUrl(calls)).toMatch(/^\/auth\/native\/google\/finish\?flow=[0-9a-f-]{36}$/);
	});

	test('a malformed query is a 400 that does not quote it', async () => {
		const { app } = build();
		for (const overrides of [
			{ code_challenge: 'short' },
			{ code_challenge_method: 'plain' },
			{ state: '' },
			{ state: 'x'.repeat(201) },
		]) {
			const res = await app.request(startUrl(overrides));
			expect(res.status).toBe(400);
			expect(res.headers.get('location')).toBeNull();
			expect(JSON.stringify(await res.json())).not.toContain('short');
		}
	});

	test('without Google configured it is a 404 auth.provider.not_configured', async () => {
		const { app } = build({ google: false });
		const res = await app.request(startUrl());
		expect(res.status).toBe(404);
		expect(res.headers.get('location')).toBeNull();
		expect((await problem(res)).code).toBe('auth.provider.not_configured');
	});
});

describe('GET /auth/native/google/finish', () => {
	test('an unknown flow is a 400 flow_expired', async () => {
		const { app } = build();
		const res = await finish(app, crypto.randomUUID());
		expect(res.status).toBe(400);
		expect((await problem(res)).code).toBe('auth.native.flow_expired');
	});

	test('a flow that is not a uuid is a 400 validation problem', async () => {
		const { app } = build();
		const res = await finish(app, 'not-a-uuid');
		expect(res.status).toBe(400);
		expect((await problem(res)).code).toBe('common.request.validation_failed');
	});

	test('a flow is single use', async () => {
		const { app, calls } = build();
		const flow = await started(app, calls);
		expect((await finish(app, flow)).status).toBe(302);
		const again = await finish(app, flow);
		expect(again.status).toBe(400);
		expect((await problem(again)).code).toBe('auth.native.flow_expired');
	});

	test('without a session cookie it is a 401 and issues no redirect', async () => {
		const { app, calls } = build();
		const res = await finish(app, await started(app, calls), false);
		expect(res.status).toBe(401);
		expect(res.headers.get('location')).toBeNull();
	});

	test('a visit without a session (a link prefetch) leaves the flow for the real one', async () => {
		const { app, calls } = build();
		const flow = await started(app, calls);
		expect((await finish(app, flow, false)).status).toBe(401);
		expect((await finish(app, flow)).status).toBe(302);
	});

	test("Google's error ends the flow with no code, even for a browser holding a session", async () => {
		const { app, calls } = build();
		const flow = await started(app, calls);
		const denied = await app.request(
			`/auth/native/google/finish?flow=${flow}&error=access_denied`,
			{ headers: { cookie: `better-auth.session_token=${encodeURIComponent(SIGNED)}` } },
		);
		expect(denied.status).toBe(401);
		expect(denied.headers.get('location')).toBeNull();
		const body = v.parse(ProblemView, await denied.json());
		expect(body.details).toEqual({ reason: 'access_denied' });
		expect((await finish(app, flow)).status).toBe(400);
	});

	test('redirects with code and state through the URL API, and expires the browser cookie', async () => {
		const { app, calls } = build();
		const { res, location, code } = await signedIn(app, calls);
		expect(`${location.protocol}//${location.host}${location.pathname}`).toBe(REDIRECT);
		expect(code).toHaveLength(43);
		expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
		// The state has `&` and a space: it must come back as one encoded value.
		expect(location.searchParams.get('state')).toBe('client state&x=1');
		expect([...location.searchParams.keys()].sort()).toEqual(['code', 'state']);
		const cookies = res.headers.getSetCookie();
		expect(cookies).toEqual([
			'better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax',
		]);
		expect(res.headers.get('x-request-id')).toBeString();
		expect(res.headers.get('referrer-policy')).toBe('no-referrer');
		expect(res.headers.get('cache-control')).toBe('no-store');
	});
});

describe('POST /auth/native/exchange', () => {
	test('the right verifier returns the signed token and the user', async () => {
		const { app, calls } = build();
		const { code } = await signedIn(app, calls);
		const res = await exchange(app, code, VERIFIER);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		const body = v.parse(SessionTokenView, await res.json());
		expect(body.token).toBe(SIGNED);
		expect(body.user.id).toBe(USER.id);
		expect(JSON.stringify(body)).not.toContain('image');
	});

	test('a wrong verifier is a 400 invalid_grant, and the burnt code fails with the right one', async () => {
		const { app, calls } = build();
		const { code } = await signedIn(app, calls);
		const wrong = await exchange(app, code, 'a'.repeat(43));
		expect(wrong.status).toBe(400);
		expect((await problem(wrong)).code).toBe('auth.native.invalid_grant');
		const retry = await exchange(app, code, VERIFIER);
		expect(retry.status).toBe(400);
		expect((await problem(retry)).code).toBe('auth.native.invalid_grant');
	});

	test('a replayed code, an unknown code and a missing code are all 400', async () => {
		const { app, calls } = build();
		const { code } = await signedIn(app, calls);
		expect((await exchange(app, code, VERIFIER)).status).toBe(200);
		const replay = await exchange(app, code, VERIFIER);
		expect(replay.status).toBe(400);
		expect((await problem(replay)).code).toBe('auth.native.invalid_grant');
		const unknown = await exchange(app, 'nope', VERIFIER);
		expect((await problem(unknown)).code).toBe('auth.native.invalid_grant');
		const missing = await app.request('/auth/native/exchange', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code_verifier: VERIFIER }),
		});
		expect(missing.status).toBe(400);
	});

	test('a verifier of the wrong shape is a 400 that does not quote it', async () => {
		const { app } = build();
		for (const verifier of ['short', `${'a'.repeat(42)}!`, 'a'.repeat(129)]) {
			const res = await exchange(app, 'whatever', verifier);
			expect(res.status).toBe(400);
			expect(JSON.stringify(await res.json())).not.toContain(verifier);
		}
	});

	test('a code is no good once its session has ended', async () => {
		const { app, calls, deps } = build();
		const { code } = await signedIn(app, calls);
		(deps.auth.api as unknown as { getSession: () => Promise<null> }).getSession = async () => null;
		const res = await exchange(app, code, VERIFIER);
		expect(res.status).toBe(400);
		expect((await problem(res)).code).toBe('auth.native.invalid_grant');
	});

	test('a malformed body is a 400', async () => {
		const { app } = build();
		const res = await app.request('/auth/native/exchange', { method: 'POST', body: '{bad' });
		expect(res.status).toBe(400);
	});
});

describe('secrets stay out of the logs', () => {
	test('the flow id, code and verifier appear in no log line', async () => {
		const { app, calls, lines } = build();
		const flow = await started(app, calls);
		const finished = await finish(app, flow);
		const code = new URL(finished.headers.get('location') ?? '').searchParams.get('code') ?? '';
		await exchange(app, code, VERIFIER);
		await exchange(app, code, VERIFIER);
		await app.request(startUrl({ redirect_uri: 'https://evil.example/cb' }));
		const everything = JSON.stringify(lines);
		expect(lines.length).toBeGreaterThan(0);
		for (const secret of [flow, code, VERIFIER, CHALLENGE, SIGNED, encodeURIComponent(SIGNED)]) {
			expect(everything).not.toContain(secret);
		}
	});
});
