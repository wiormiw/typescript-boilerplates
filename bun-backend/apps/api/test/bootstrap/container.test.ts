import { describe, expect, test } from 'bun:test';
import { BunSqlDatabase } from '@starter/db';
import { loadEnv } from '@starter/lib/config';
import { Env } from '#src/bootstrap/config.ts';
import { buildContainer } from '#src/bootstrap/container.ts';
import { Valkey } from '#src/infra/valkey.ts';
import { RuntimeMetrics } from '#src/infra/runtime-metrics.ts';

const env = loadEnv(Env, {
	DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
	VALKEY_URL: 'redis://127.0.0.1:1',
	OBSERVABILITY_LEVEL: 'off',
	LOG_LEVEL: 'fatal',
});

describe('buildContainer', () => {
	test('registers everything without starting any resource', async () => {
		const container = buildContainer(env);
		try {
			expect(container.get('env')).toBe(env);
			expect(container.get('clock').now()).toBeDefined();
			expect(container.get('lifecycle').phase()).toBe('starting');
			expect(container.get('database')).toBeInstanceOf(BunSqlDatabase);
			expect(container.get('valkey')).toBeInstanceOf(Valkey);
			expect(container.get('runtimeMetrics')).toBeInstanceOf(RuntimeMetrics);
			expect(container.get('telemetry')[Symbol.asyncDispose]).toBeFunction();
			expect(container.get('logger')).toBeDefined();
		} finally {
			await container.dispose();
		}
	});
});
