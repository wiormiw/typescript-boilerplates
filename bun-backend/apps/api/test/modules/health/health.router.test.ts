import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { HealthView, ReadinessView } from '@starter/contracts';
import { Lifecycle } from '@starter/lib/lifecycle';
import { silentLogger } from '@starter/lib/log';
import { testApp } from '../../support/app.ts';

describe('meta routes', () => {
	test('healthz is 200 without calling checks', async () => {
		let calls = 0;
		const { app } = testApp({
			checks: async () => {
				calls++;
				return {};
			},
		});
		const res = await app.request('/healthz');
		expect(res.status).toBe(200);
		expect(v.parse(HealthView, await res.json())).toEqual({ status: 'ok' });
		expect(calls).toBe(0);
	});

	test('healthz stays 200 while draining', async () => {
		const { app, lifecycle } = testApp();
		lifecycle.beginDraining('test');
		expect((await app.request('/healthz')).status).toBe(200);
	});

	test('readyz is 503 draining after beginDraining', async () => {
		const { app, lifecycle } = testApp();
		lifecycle.beginDraining('test');
		const res = await app.request('/readyz');
		expect(res.status).toBe(503);
		expect(v.parse(ReadinessView, await res.json())).toEqual({ status: 'draining' });
	});

	test('readyz is 503 degraded with valkey:false when that check fails', async () => {
		const { app } = testApp({
			checks: async () => ({ database: { ok: true }, valkey: { ok: false, detail: 'down' } }),
		});
		const res = await app.request('/readyz');
		expect(res.status).toBe(503);
		const body = v.parse(ReadinessView, await res.json());
		// The extras survive the view (looseObject), and the detail never reaches the wire.
		expect(body).toEqual({ status: 'degraded', database: true, valkey: false });
	});

	test('the readyz body has exactly the keys of the ReadinessView sample', async () => {
		const sample = (await Bun.file(
			new URL('../../../../../packages/contracts/samples/ReadinessView.json', import.meta.url),
		).json()) as Record<string, unknown>;
		const { app } = testApp();
		const body = (await (await app.request('/readyz')).json()) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(Object.keys(sample).sort());
	});

	test('readyz is 200 ready when all checks pass', async () => {
		const { app } = testApp();
		const res = await app.request('/readyz');
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'ready', database: true, valkey: true });
	});

	test('readyz is 503 while the process is still starting', async () => {
		const { app } = testApp({ lifecycle: new Lifecycle(silentLogger()) });
		const res = await app.request('/readyz');
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ status: 'draining' });
	});

	test('readyz is 503 degraded when checks throws', async () => {
		const { app } = testApp({
			checks: async () => {
				throw new Error('boom');
			},
		});
		const res = await app.request('/readyz');
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ status: 'degraded' });
	});

	test('a check named status cannot override the status', async () => {
		const { app } = testApp({ checks: async () => ({ status: { ok: false } }) });
		const res = await app.request('/readyz');
		expect(await res.json()).toEqual({ status: 'degraded' });
	});
});
