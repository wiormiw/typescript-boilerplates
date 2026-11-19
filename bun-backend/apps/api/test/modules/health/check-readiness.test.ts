import { describe, expect, test } from 'bun:test';
import { createLifecycle, type HealthResult } from '@starter/lib/lifecycle';
import { silentLogger } from '@starter/lib/log';
import { captureLogger } from '@starter/lib/testing';
import { checkReadiness } from '#src/modules/health/use-cases/check-readiness.ts';

/** The use case over a ready lifecycle, with the failing-set kept across calls like the module does. */
function readiness(checks: () => Promise<Record<string, HealthResult>>) {
	const { logger, lines } = captureLogger();
	const lifecycle = createLifecycle(silentLogger());
	lifecycle.markReady();
	const deps = { lifecycle, logger, checks, failing: new Set<string>() };
	return { lines, run: () => checkReadiness(deps, AbortSignal.timeout(1000)) };
}

describe('checkReadiness logging', () => {
	const level = { info: 30, warn: 40, error: 50 };

	test('logs a failing check at warn once, then recovery at info, and nothing while steady', async () => {
		let result: Record<string, HealthResult> = { database: { ok: true }, valkey: { ok: true } };
		const { lines, run } = readiness(async () => result);
		await run();
		expect(lines).toEqual([]);

		result = { database: { ok: true }, valkey: { ok: false, detail: 'connection refused' } };
		await run();
		await run();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			level: level.warn,
			check: 'valkey',
			detail: 'connection refused',
			msg: 'readiness check failing',
		});

		result = { database: { ok: true }, valkey: { ok: true } };
		await run();
		await run();
		expect(lines).toHaveLength(2);
		expect(lines[1]).toMatchObject({ level: level.info, check: 'valkey' });
	});

	test('a throwing checks() is logged at error once and reported degraded', async () => {
		const { lines, run } = readiness(async () => {
			throw new Error('boom');
		});
		// The use case maps the throw to a degraded answer; the router never sees the error.
		expect(await run()).toEqual({ status: 'degraded', flags: {} });
		expect(await run()).toEqual({ status: 'degraded', flags: {} });
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ level: level.error, msg: 'readiness checks threw' });
	});
});
