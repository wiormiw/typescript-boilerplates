import { describe, expect, test } from 'bun:test';
import { loadEnv } from '@starter/lib/config';
import { assertEnvBudgets, assertEnvSafe, Env } from '#src/bootstrap/config.ts';

const required = {
	DATABASE_URL: 'postgres://u:p@127.0.0.1:4632/db',
	VALKEY_URL: 'redis://127.0.0.1:4679',
	AUTH_SECRET: 'x'.repeat(32),
};

describe('Env', () => {
	test('loadEnv lists every bad key', () => {
		let message = '';
		try {
			loadEnv(Env, { PORT: 'abc', DATABASE_URL: 'nope' });
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain('PORT');
		expect(message).toContain('DATABASE_URL');
		expect(message).toContain('VALKEY_URL');
	});

	test('defaults fill an empty env except required URLs', () => {
		const env = loadEnv(Env, required);
		expect(env).toMatchObject({
			PORT: 4600,
			ROLE: 'all',
			DB_POOL_MAX: 10,
			DB_IDLE_TIMEOUT_S: 30,
			DB_CONNECT_TIMEOUT_S: 5,
			DB_CLOSE_TIMEOUT_S: 5,
			DB_STATEMENT_TIMEOUT_MS: 5000,
			DB_LOCK_TIMEOUT_MS: 2000,
			DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: 10_000,
			DB_SLOW_QUERY_MS: 200,
			VALKEY_CONNECT_TIMEOUT_MS: 2000,
			REQUEST_TIMEOUT_MS: 10_000,
			DRAIN_TIMEOUT_MS: 10_000,
			PRE_STOP_DELAY_MS: 3000,
			SHUTDOWN_TIMEOUT_MS: 20_000,
			OTEL_SERVICE_NAME: 'starter-api',
			OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4617',
			OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
			OBSERVABILITY_LEVEL: 'traces-sampled',
			TRACE_SAMPLE_RATIO: 0.1,
			DEBUG_ROUTES: false,
			AUTH_BASE_URL: 'http://127.0.0.1:4600',
			SIGNUP_ENABLED: false,
			NATIVE_REDIRECT_URIS: ['starter://auth/callback'],
			MAIL_TRANSPORT: 'log',
		});
	});

	test('config defaults to grpc on 4617', () => {
		const env = loadEnv(Env, required);
		expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('grpc');
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://localhost:4617');
		expect(() => loadEnv(Env, { ...required, OTEL_EXPORTER_OTLP_PROTOCOL: 'udp' })).toThrow(
			'OTEL_EXPORTER_OTLP_PROTOCOL',
		);
	});

	test('an empty value counts as unset', () => {
		expect(loadEnv(Env, { ...required, PORT: '' }).PORT).toBe(4600);
	});

	test('the ratio must be within 0 and 1', () => {
		expect(() => loadEnv(Env, { ...required, TRACE_SAMPLE_RATIO: '1.5' })).toThrow(
			'TRACE_SAMPLE_RATIO',
		);
	});

	test('drain plus pre-stop delay must fit inside the shutdown deadline', () => {
		const env = loadEnv(Env, required);
		expect(() => assertEnvBudgets(env)).not.toThrow();
		expect(() => assertEnvBudgets({ ...env, SHUTDOWN_TIMEOUT_MS: 13_000 })).toThrow(
			'DRAIN_TIMEOUT_MS + PRE_STOP_DELAY_MS',
		);
	});

	test('the pool close time counts against the shutdown deadline too', () => {
		const env = loadEnv(Env, required);
		// 3000 + 10000 fits in 17000; adding the 5 s close does not.
		expect(() => assertEnvBudgets({ ...env, SHUTDOWN_TIMEOUT_MS: 17_000 })).toThrow(
			'DB_CLOSE_TIMEOUT_S',
		);
		expect(() => assertEnvBudgets({ ...env, SHUTDOWN_TIMEOUT_MS: 18_001 })).not.toThrow();
	});

	test.each(['HEALTH_CHECK_TIMEOUT_MS', 'RATE_LIMIT_TIMEOUT_MS'] as const)(
		'%s must fit inside the request deadline',
		(key) => {
			const env = loadEnv(Env, required);
			const deadline = env.REQUEST_TIMEOUT_MS;
			expect(() => assertEnvBudgets({ ...env, [key]: deadline })).toThrow(key);
			expect(() => assertEnvBudgets({ ...env, [key]: deadline - 1 })).not.toThrow();
		},
	);

	test('debug routes are refused in production', () => {
		const prod = loadEnv(Env, { ...required, NODE_ENV: 'production', DEBUG_ROUTES: 'true' });
		expect(() => assertEnvSafe(prod)).toThrow('DEBUG_ROUTES');
		const dev = loadEnv(Env, { ...required, DEBUG_ROUTES: 'true' });
		expect(() => assertEnvSafe(dev)).not.toThrow();
	});
});

describe('auth settings', () => {
	test('a short AUTH_SECRET is rejected by name', () => {
		expect(() => loadEnv(Env, { ...required, AUTH_SECRET: 'short' })).toThrow('AUTH_SECRET');
	});

	test('NATIVE_REDIRECT_URIS is trimmed and drops empty items', () => {
		const env = loadEnv(Env, { ...required, NATIVE_REDIRECT_URIS: ' a , ,b ' });
		expect(env.NATIVE_REDIRECT_URIS).toEqual(['a', 'b']);
	});

	test('Google needs both its id and its secret', () => {
		const idOnly = loadEnv(Env, { ...required, GOOGLE_CLIENT_ID: 'id' });
		expect(() => assertEnvSafe(idOnly)).toThrow('GOOGLE_CLIENT_ID');
		const secretOnly = loadEnv(Env, { ...required, GOOGLE_CLIENT_SECRET: 's' });
		expect(() => assertEnvSafe(secretOnly)).toThrow('GOOGLE_CLIENT_SECRET');
		const both = loadEnv(Env, { ...required, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' });
		expect(() => assertEnvSafe(both)).not.toThrow();
	});

	test('the log mailer is refused in production', () => {
		const prod = loadEnv(Env, { ...required, NODE_ENV: 'production', MAIL_TRANSPORT: 'log' });
		expect(() => assertEnvSafe(prod)).toThrow('MAIL_TRANSPORT');
	});
});

test('.env.example parses and names every Env key', async () => {
	const text = await Bun.file(`${import.meta.dir}/../../../../.env.example`).text();
	const values = Object.fromEntries(
		text
			.split('\n')
			.filter((line) => /^[A-Z_]+=/.test(line))
			.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
	);
	expect(Object.keys(Env.entries).filter((key) => !(key in values))).toEqual([]);
	// AUTH_SECRET is deliberately empty in the example: the operator generates it.
	expect(() => loadEnv(Env, { ...values, AUTH_SECRET: 'x'.repeat(32) })).not.toThrow();
});
