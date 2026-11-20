import { loadEnv } from '@starter/lib/config';
import { Env } from '#src/bootstrap/config.ts';

/** A valid Env pointing at nothing (port 1): for tests that build the container but connect nowhere. */
export const unreachableEnv = (overrides: Record<string, string> = {}) =>
	loadEnv(Env, {
		DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
		VALKEY_URL: 'redis://127.0.0.1:1',
		AUTH_SECRET: 'x'.repeat(32),
		OBSERVABILITY_LEVEL: 'off',
		...overrides,
	});

/** Every setting at its default: what tests take instead of repeating a value from config.ts. */
export const defaults = unreachableEnv();
