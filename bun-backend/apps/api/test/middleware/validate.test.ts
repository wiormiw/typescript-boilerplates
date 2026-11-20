import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import * as v from 'valibot';
import { ProblemView } from '@starter/contracts';
import { Lifecycle } from '@starter/lib/lifecycle';
import { captureLogger } from '@starter/lib/testing';
import { createApp } from '#src/bootstrap/app.ts';
import { signedIn } from '#src/middleware/session.ts';
import { jsonBody, queryParams } from '#src/middleware/validate.ts';
import type { AppEnv } from '#src/shared/http/types.ts';
import { httpLimits } from '../support/app.ts';

const Body = v.object({ name: v.pipe(v.string(), v.minLength(2)) });
const Optional = v.object({ note: v.optional(v.string()) });
const Query = v.object({ code: v.pipe(v.string(), v.length(4)) });

function app() {
	const { logger } = captureLogger();
	const lifecycle = new Lifecycle(logger);
	lifecycle.markReady();
	const routes = new Hono<AppEnv>()
		.post('/body', jsonBody(Body), (c) => c.json(c.req.valid('json')))
		.post('/optional', jsonBody(Optional), (c) => c.json(c.req.valid('json')))
		.post('/private', signedIn, jsonBody(Body), (c) => c.json(c.req.valid('json')))
		.get('/secret', queryParams(Query, { redact: true }), (c) => c.json(c.req.valid('query')));
	return createApp({
		logger,
		lifecycle,
		modules: [{ name: 'probe', routes }],
		authenticate: async () => undefined,
		...httpLimits,
		debugRoutes: false,
	});
}

const json = (body: string) => ({
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body,
});
const problem = async (res: Response) => v.parse(ProblemView, await res.json());

describe('jsonBody', () => {
	test('a valid body reaches the route as the schema output', async () => {
		const res = await app().request('/body', json('{"name":"Ann"}'));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ name: 'Ann' });
	});

	test('an invalid body is a 400 naming the field and why', async () => {
		const res = await app().request('/body', json('{"name":"A"}'));
		expect(res.status).toBe(400);
		const body = await problem(res);
		expect(body.code).toBe('common.request.validation_failed');
		expect(body.details).toEqual({ issues: [{ path: 'name', message: expect.any(String) }] });
	});

	test('malformed JSON is a 400 validation problem, not a 500', async () => {
		const res = await app().request('/body', json('{"name":'));
		expect(res.status).toBe(400);
		expect((await problem(res)).code).toBe('common.request.validation_failed');
	});

	test('no body at all is read as {}, so all-optional bodies may be left out', async () => {
		const res = await app().request('/optional', { method: 'POST' });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({});
	});

	test('behind signedIn, a signed-out caller hears 401 before anything about the body', async () => {
		const res = await app().request('/private', json('{"name":"A"}'));
		expect(res.status).toBe(401);
		expect((await problem(res)).code).toBe('auth.session.unauthenticated');
	});
});

describe('queryParams with redact', () => {
	test('a failing field is named but its value never comes back', async () => {
		const secret = 'leaked-value-123';
		const res = await app().request(`/secret?code=${secret}`);
		expect(res.status).toBe(400);
		const text = await res.text();
		expect(text).not.toContain(secret);
		expect(JSON.parse(text).details).toEqual({ issues: [{ path: 'code', message: 'invalid' }] });
	});
});
