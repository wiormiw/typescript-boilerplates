import { describe, expect, test } from 'bun:test';
import { noContent, passThrough } from '#src/shared/http/reply.ts';
import { testApp } from '../../support/app.ts';

describe('noContent', () => {
	test('is an empty 204 that keeps the headers set on the context', async () => {
		const { app } = testApp();
		app.get('/gone', (c) => noContent(c));
		const res = await app.request('/gone');
		expect(res.status).toBe(204);
		expect(await res.text()).toBe('');
		expect(res.headers.get('x-request-id')).toBeTruthy();
	});
});

describe('passThrough', () => {
	test('re-sends a foreign response with its cookies and the context headers', async () => {
		const { app } = testApp();
		app.get('/foreign', (c) =>
			passThrough(
				c,
				new Response('{"a":1}', {
					status: 201,
					headers: [
						['set-cookie', 'a=1'],
						['set-cookie', 'b=2'],
						['content-type', 'application/json'],
					],
				}),
			),
		);
		const res = await app.request('/foreign');
		expect(res.status).toBe(201);
		expect(await res.text()).toBe('{"a":1}');
		expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
		expect(res.headers.get('content-type')).toBe('application/json');
		expect(res.headers.get('x-request-id')).toBeTruthy();
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
	});

	test.each([204, 205, 304])('a %i goes out without a body', async (status) => {
		const { app } = testApp();
		app.get('/empty', (c) => passThrough(c, new Response(null, { status })));
		const res = await app.request('/empty');
		expect(res.status).toBe(status);
		expect(await res.text()).toBe('');
		expect(res.headers.get('x-request-id')).toBeTruthy();
	});

	test('a redirect keeps its location and cookies', async () => {
		const { app } = testApp();
		const redirect = new Response(null, {
			status: 302,
			headers: [
				['location', '/next'],
				['set-cookie', 'a=1'],
			],
		});
		app.get('/moved', (c) => passThrough(c, redirect));
		const res = await app.request('/moved');
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/next');
		expect(res.headers.getSetCookie()).toEqual(['a=1']);
	});
});
