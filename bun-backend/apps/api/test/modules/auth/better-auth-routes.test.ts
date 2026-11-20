import { afterEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { ProblemView } from '@starter/contracts';
import { Lifecycle } from '@starter/lib/lifecycle';
import { silentLogger } from '@starter/lib/log';
import { systemClock } from '@starter/lib/time';
import { createApp } from '#src/bootstrap/app.ts';
import { createAuthModule } from '#src/modules/auth/auth.module.ts';
import type { RateLimitStore } from '#src/infra/types.ts';
import { CLIENT_ADDRESS_HEADER } from '#src/shared/http/client-address.ts';
import { memoryAuthCodes } from '../../support/auth-codes.ts';
import { testAuth } from '../../support/auth.ts';
import { memoryRateLimit } from '../../support/rate-limit.ts';
import { database, live } from './support.ts';
import { serveOnLoopback } from '../../support/serve.ts';
import { httpLimits } from '../../support/app.ts';
import { defaults } from '../../support/env.ts';

const maybe = live ? describe : describe.skip;

/** The real router over a real better-auth, with buckets of its own (or the store given). */
function app(rateLimit: RateLimitStore = memoryRateLimit(systemClock)) {
	const logger = silentLogger();
	const lifecycle = new Lifecycle(logger);
	lifecycle.markReady();
	const { auth } = testAuth({
		database,
		env: { SIGNUP_ENABLED: false },
		rateLimit,
		shutdown: lifecycle.signal,
	});
	return createApp({
		logger,
		lifecycle,
		modules: [
			createAuthModule({
				auth,
				database,
				logger,
				authCodes: memoryAuthCodes(systemClock),
				redirectUris: [],
				flowTtlS: defaults.NATIVE_FLOW_TTL_S,
				codeTtlS: defaults.NATIVE_CODE_TTL_S,
			}),
		],
		authenticate: async () => undefined,
		...httpLimits,
		debugRoutes: false,
	});
}

const signIn = (api: ReturnType<typeof app>, headers: Record<string, string>) =>
	api.request('/auth/sign-in/email', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong password' }),
	});

maybe('sign-in rate limit', () => {
	test('a new x-forwarded-for per request does not buy a new bucket', async () => {
		const api = app();
		const statuses: number[] = [];
		for (let i = 1; i <= 6; i++) {
			const res = await signIn(api, { 'x-forwarded-for': `198.51.100.${i}` });
			statuses.push(res.status);
			if (res.status === 429) {
				expect(v.parse(ProblemView, await res.json()).code).toBe('common.request.rate_limited');
				expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
			}
		}
		expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
	});

	test('nor does a client sending the trusted header itself', async () => {
		const api = app();
		const statuses: number[] = [];
		for (let i = 1; i <= 6; i++) {
			const res = await signIn(api, { [CLIENT_ADDRESS_HEADER]: `198.51.100.${i}` });
			statuses.push(res.status);
		}
		expect(statuses.at(-1)).toBe(429);
	});
});

maybe('better-auth routes our own replace', () => {
	// DELETE /me demands the password of a password account and DELETE /me/sessions writes the
	// audit row; better-auth's own routes would skip both.
	test.each(['/auth/delete-user', '/auth/revoke-sessions'])('%s answers 404', async (path) => {
		const res = await app().request(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
			body: '{}',
		});
		expect(res.status).toBe(404);
		expect(v.parse(ProblemView, await res.json()).code).toBe('common.route.not_found');
	});
});

describe('the client address under a real server', () => {
	let server: ReturnType<typeof serveOnLoopback> | undefined;
	afterEach(() => server?.stop(true));

	// better-auth falls back to 127.0.0.1 in tests when the header is missing, so the proof is the
	// request it is handed: the header must carry the socket's peer, not what the client sent.
	test('better-auth is handed the socket peer, whatever the client claims', async () => {
		const seen: (string | null)[] = [];
		const logger = silentLogger();
		const lifecycle = new Lifecycle(logger);
		lifecycle.markReady();
		const auth = {
			handler: async (request: Request) => {
				seen.push(request.headers.get(CLIENT_ADDRESS_HEADER));
				return Response.json({});
			},
			api: {},
			options: {},
		};
		const api = createApp({
			logger,
			lifecycle,
			modules: [
				createAuthModule({
					auth,
					database,
					logger,
					authCodes: memoryAuthCodes(systemClock),
					redirectUris: [],
					flowTtlS: defaults.NATIVE_FLOW_TTL_S,
					codeTtlS: defaults.NATIVE_CODE_TTL_S,
				} as unknown as Parameters<typeof createAuthModule>[0]),
			],
			authenticate: async () => undefined,
			...httpLimits,
			debugRoutes: false,
		});
		server = serveOnLoopback(api.fetch);
		await fetch(new URL('/auth/sign-in/email', server.url), {
			method: 'POST',
			headers: { 'x-forwarded-for': '198.51.100.7', [CLIENT_ADDRESS_HEADER]: '203.0.113.9' },
		});
		// Bun reports an IPv4 peer as itself or IPv4-mapped IPv6, depending on the socket.
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
	});
});
