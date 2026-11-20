import { describe, expect, test } from 'bun:test';
import { BunSqlDatabase } from '@starter/db';
import { buildContainer } from '#src/bootstrap/container.ts';
import { Valkey } from '#src/infra/valkey.ts';
import { RuntimeMetrics } from '#src/infra/runtime-metrics.ts';
import { unreachableEnv } from '../support/env.ts';

const env = unreachableEnv({ LOG_LEVEL: 'fatal' });

describe('buildContainer', () => {
	test('registers everything without starting any resource', async () => {
		const container = buildContainer(env);
		try {
			expect(container.get('env')).toBe(env);
			expect(container.get('clock').now()).toBeDefined();
			expect(container.get('lifecycle').phase()).toBe('starting');
			expect(container.get('database')).toBeInstanceOf(BunSqlDatabase);
			expect(container.get('valkey')).toBeInstanceOf(Valkey);
			expect(container.get('mailer').send).toBeFunction();
			expect(container.get('auth').handler).toBeFunction();
			expect(container.get('runtimeMetrics')).toBeInstanceOf(RuntimeMetrics);
			expect(container.get('telemetry')[Symbol.asyncDispose]).toBeFunction();
			expect(container.get('logger')).toBeDefined();
		} finally {
			await container.dispose();
		}
	});
});
