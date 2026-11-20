import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { ProblemView } from '@starter/contracts';
import { recordMetrics } from '../support/metrics.ts';
import { testApp } from '../support/app.ts';

const meters = recordMetrics();

describe('app', () => {
	test('security headers ride on every response', async () => {
		const { app } = testApp();
		const res = await app.request('/healthz');
		expect(res.headers.get('x-content-type-options')).toBe('nosniff');
		expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
		expect(res.headers.get('referrer-policy')).toBe('no-referrer');
	});

	test('an unknown route is a 404 problem that matches ProblemView', async () => {
		const { app } = testApp();
		const res = await app.request('/nope');
		expect(res.status).toBe(404);
		expect(res.headers.get('content-type')).toContain('application/problem+json');
		expect(v.parse(ProblemView, await res.json())).toMatchObject({
			code: 'common.route.not_found',
		});
	});

	test('an oversized body is a 413 problem', async () => {
		const { app } = testApp();
		app.post('/echo', async (c) => c.text(await c.req.text()));
		const res = await app.request('/echo', { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024) });
		expect(res.status).toBe(413);
		expect(v.parse(ProblemView, await res.json())).toMatchObject({
			code: 'common.request.payload_too_large',
		});
	});

	test('a TimeoutError from a library, not only the platform, is a 504 problem', async () => {
		const { app } = testApp();
		app.get('/slow', () => {
			throw Object.assign(new Error('upstream gave up'), { name: 'TimeoutError' });
		});
		const res = await app.request('/slow');
		expect(res.status).toBe(504);
		expect(v.parse(ProblemView, await res.json())).toMatchObject({
			code: 'common.request.timeout',
		});
	});

	test('an AbortError while the deadline has not passed is not a timeout', async () => {
		const { app } = testApp();
		app.get('/aborted', () => {
			throw Object.assign(new Error('aborted'), { name: 'AbortError' });
		});
		expect((await app.request('/aborted')).status).toBe(500);
	});

	test('an unexpected throw is a 500 problem that hides the message', async () => {
		const { app, lines } = testApp();
		await meters.collect();
		app.get('/boom', () => {
			throw new Error('password=hunter2');
		});
		const res = await app.request('/boom');
		expect(res.status).toBe(500);
		const problem = v.parse(ProblemView, await res.json());
		expect(problem.requestId).toBe(res.headers.get('x-request-id')!);
		expect(problem.detail).toContain('request id');
		const text = JSON.stringify(problem);
		expect(text).not.toContain('hunter2');
		expect(lines.some((line) => line['msg'] === 'unhandled error')).toBe(true);
		const duration = (await meters.collect()).find(
			(metric) => metric.descriptor.name === 'http.server.request.duration',
		);
		expect(
			duration!.dataPoints.map((p) => [
				p.attributes['http.route'],
				p.attributes['http.response.status_code'],
			]),
		).toContainEqual(['/boom', 500]);
	});

	test('the debug route is absent unless debugRoutes is on', async () => {
		const { app } = testApp({ debugRoutes: false });
		expect((await app.request('/_debug/sleep?ms=1')).status).toBe(404);
	});

	test('the debug sleep refuses ms above 30000', async () => {
		const { app } = testApp();
		const res = await app.request('/_debug/sleep?ms=30001');
		expect(res.status).toBe(400);
		expect(v.parse(ProblemView, await res.json()).code).toBe('common.request.validation_failed');
	});
});
