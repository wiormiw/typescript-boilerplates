import * as v from 'valibot';
import { assertNestedBudget, baseEnv, bool, int, oneOfEnv, str, url } from '@starter/lib/config';
import { OBSERVABILITY_LEVELS, OTLP_PROTOCOLS } from '@starter/lib/observability';

// A share between 0 and 1, which `int` can't express.
const ratio = (fallback: number) =>
	v.pipe(
		v.optional(v.string(), String(fallback)),
		v.transform(Number),
		v.number('must be a number'),
		v.minValue(0, 'must be at least 0'),
		v.maxValue(1, 'must be at most 1'),
	);

/** Deployment settings: what legitimately differs between a laptop and production. */
export const Env = v.object({
	...baseEnv,
	// The repo's own ports and deadlines replace the shared defaults.
	// grpc on 4617 by default; the HTTP flavours are on 4618 (the benchmark in B10 picks the default).
	OTEL_EXPORTER_OTLP_PROTOCOL: oneOfEnv(OTLP_PROTOCOLS, 'grpc'),
	OTEL_EXPORTER_OTLP_ENDPOINT: url('http://localhost:4617'),
	SHUTDOWN_TIMEOUT_MS: int({ min: 0, default: 20_000 }),
	PRE_STOP_DELAY_MS: int({ min: 0, default: 3000 }),

	PORT: int({ min: 1, max: 65_535, default: 4600 }),
	ROLE: oneOfEnv(['api', 'worker', 'all'], 'all'),
	REQUEST_TIMEOUT_MS: int({ min: 100, default: 10_000 }),

	DATABASE_URL: url(),
	DB_POOL_MAX: int({ min: 1, max: 200, default: 10 }),
	DB_IDLE_TIMEOUT_S: int({ min: 1, default: 30 }),
	DB_CONNECT_TIMEOUT_S: int({ min: 1, default: 5 }),
	DB_CLOSE_TIMEOUT_S: int({ min: 1, default: 5 }),
	// Enforced by Postgres itself, so a slow query or a lock wait gives its connection back instead
	// of holding one of DB_POOL_MAX until it finishes. Under REQUEST_TIMEOUT_MS on purpose.
	DB_STATEMENT_TIMEOUT_MS: int({ min: 0, default: 5000 }),
	DB_LOCK_TIMEOUT_MS: int({ min: 0, default: 2000 }),
	DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: int({ min: 0, default: 10_000 }),
	DB_SLOW_QUERY_MS: int({ min: 0, default: 200 }),

	VALKEY_URL: url(),
	VALKEY_CONNECT_TIMEOUT_MS: int({ min: 100, default: 2000 }),

	OTEL_SERVICE_NAME: str({ default: 'starter-api' }),
	OBSERVABILITY_LEVEL: oneOfEnv(OBSERVABILITY_LEVELS, 'traces-sampled'),
	TRACE_SAMPLE_RATIO: ratio(0.1),

	// Mounts routes that exist to provoke failures (a slow request); never on in production.
	DEBUG_ROUTES: bool(false),
});

export type Env = v.InferOutput<typeof Env>;

/**
 * Startup check: the pre-stop wait, the one drain window and the pool's close must all fit inside
 * the shutdown deadline, since `stop` runs them one after another.
 */
export function assertEnvBudgets(env: Env): void {
	assertNestedBudget(
		'DRAIN_TIMEOUT_MS + PRE_STOP_DELAY_MS',
		env.DRAIN_TIMEOUT_MS + env.PRE_STOP_DELAY_MS,
		env.SHUTDOWN_TIMEOUT_MS,
	);
	assertNestedBudget(
		'PRE_STOP_DELAY_MS + DRAIN_TIMEOUT_MS + DB_CLOSE_TIMEOUT_S * 1000',
		env.PRE_STOP_DELAY_MS + env.DRAIN_TIMEOUT_MS + env.DB_CLOSE_TIMEOUT_S * 1000,
		env.SHUTDOWN_TIMEOUT_MS,
	);
}

/** Startup check: settings that are fine on a laptop and wrong in production. */
export function assertEnvSafe(env: Env): void {
	if (env.DEBUG_ROUTES && env.NODE_ENV === 'production') {
		throw new Error(
			'Invalid environment configuration:\n  DEBUG_ROUTES=true is not allowed when NODE_ENV=production.',
		);
	}
}
