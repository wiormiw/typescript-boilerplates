import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import * as v from 'valibot';
import { ProblemView } from '@starter/contracts';
import { Lifecycle } from '@starter/lib/lifecycle';
import { captureLogger } from '@starter/lib/testing';
import { createApp } from '#src/bootstrap/app.ts';
import { requireUser } from '#src/shared/http/session.ts';
import type { AppEnv, AuthenticatedSession, Authenticate } from '#src/shared/http/types.ts';
import { httpLimits } from '../support/app.ts';

const USER_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const found: AuthenticatedSession = {
	user: { id: USER_ID, email: 'a@example.com', name: 'A', emailVerified: true },
	sessionId: 's1',
};

function appWith(authenticate: Authenticate) {
	const { logger, lines } = captureLogger();
	const lifecycle = new Lifecycle(logger);
	lifecycle.markReady();
	const routes = new Hono<AppEnv>().get('/whoami', (c) => c.json({ id: requireUser(c).user.id }));
	const app = createApp({
		logger,
		lifecycle,
		modules: [{ name: 'probe', routes }],
		authenticate,
		...httpLimits,
		debugRoutes: false,
	});
	return { app, lines };
}

describe('session middleware', () => {
	test('a session lets requireUser answer with the user id', async () => {
		const { app } = appWith(async () => found);
		const res = await app.request('/whoami', { headers: { authorization: 'Bearer t' } });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ id: USER_ID });
	});

	test('no session answers 401 problem+json with a request id', async () => {
		const { app } = appWith(async () => undefined);
		const res = await app.request('/whoami', { headers: { authorization: 'Bearer t' } });
		expect(res.status).toBe(401);
		expect(res.headers.get('content-type')).toContain('application/problem+json');
		expect(res.headers.get('x-request-id')).toBeTruthy();
		const body = v.parse(ProblemView, await res.json());
		expect(body.code).toBe('auth.session.unauthenticated');
	});

	test('without an authorization header authenticate is never called', async () => {
		let calls = 0;
		const { app } = appWith(async () => {
			calls++;
			return found;
		});
		const res = await app.request('/whoami');
		expect(res.status).toBe(401);
		expect(calls).toBe(0);
	});

	test('authenticate receives the request authorization header', async () => {
		const seen: (string | null)[] = [];
		const { app } = appWith(async (headers) => {
			seen.push(headers.get('authorization'));
			return found;
		});
		await app.request('/whoami', { headers: { authorization: 'Bearer abc.def' } });
		expect(seen).toEqual(['Bearer abc.def']);
	});

	test('a throwing authenticate is a 500, logged once', async () => {
		const { app, lines } = appWith(async () => {
			throw new Error('db down');
		});
		const res = await app.request('/whoami', { headers: { authorization: 'Bearer t' } });
		expect(res.status).toBe(500);
		expect(lines.filter((l) => l['level'] === 50)).toHaveLength(1);
	});
});
