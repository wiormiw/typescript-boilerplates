import * as v from 'valibot';
import {
	assertNestedBudget,
	baseEnv,
	bool,
	int,
	list,
	oneOfEnv,
	str,
	url,
} from '@starter/lib/config';
import { MAIL_TRANSPORTS } from '#src/infra/mailer.ts';
import {
	DEFAULT_OBSERVABILITY_LEVEL,
	DEFAULT_TRACE_SAMPLE_RATIO,
	OBSERVABILITY_LEVELS,
	OTLP_PROTOCOLS,
} from '@starter/lib/observability';

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
	// The repo's own ports and deadlines.
	// grpc on 4617 by default; the HTTP flavours are on 4618 (the benchmark in B10 picks the default).
	OTEL_EXPORTER_OTLP_PROTOCOL: oneOfEnv(OTLP_PROTOCOLS, 'grpc'),
	OTEL_EXPORTER_OTLP_ENDPOINT: url('http://localhost:4617'),
	SHUTDOWN_TIMEOUT_MS: int({ min: 0, default: 20_000 }),
	// Retry-After on a request cut off by shutdown: by then another instance takes it.
	SHUTDOWN_RETRY_AFTER_S: int({ min: 1, default: 5 }),
	PRE_STOP_DELAY_MS: int({ min: 0, default: 3000 }),

	PORT: int({ min: 1, max: 65_535, default: 4600 }),
	ROLE: oneOfEnv(['api', 'worker', 'all'], 'all'),
	REQUEST_TIMEOUT_MS: int({ min: 100, default: 10_000 }),
	// Bun refuses a larger body before it is read; the body-limit middleware answers it as a 413.
	MAX_REQUEST_BODY_BYTES: int({ min: 1024, default: 1_048_576 }),
	// How long one readiness probe of Postgres or Valkey may wait: a slower answer is a failure.
	HEALTH_CHECK_TIMEOUT_MS: int({ min: 100, default: 1000 }),
	// Added to the connect timeouts to bound startup as a whole, so each can run out and report.
	STARTUP_SLACK_MS: int({ min: 0, default: 2000 }),

	DATABASE_URL: url(),
	// The owner connection, read only by `db:migrate`; the API never opens it.
	DATABASE_MIGRATION_URL: v.optional(url()),
	// How long `db:migrate` may run as a whole.
	MIGRATION_TIMEOUT_MS: int({ min: 1000, default: 60_000 }),
	DB_POOL_MAX: int({ min: 1, max: 200, default: 10 }),
	DB_IDLE_TIMEOUT_S: int({ min: 1, default: 30 }),
	DB_CONNECT_TIMEOUT_S: int({ min: 1, default: 5 }),
	DB_CLOSE_TIMEOUT_S: int({ min: 1, default: 5 }),
	// Connections are recycled after this, before infrastructure drops them silently.
	DB_MAX_LIFETIME_S: int({ min: 60, default: 1800 }),
	// Enforced by Postgres itself, so a slow query or a lock wait gives its connection back instead
	// of holding one of DB_POOL_MAX until it finishes. Under REQUEST_TIMEOUT_MS on purpose.
	DB_STATEMENT_TIMEOUT_MS: int({ min: 0, default: 5000 }),
	DB_LOCK_TIMEOUT_MS: int({ min: 0, default: 2000 }),
	DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: int({ min: 0, default: 10_000 }),
	DB_SLOW_QUERY_MS: int({ min: 0, default: 200 }),

	VALKEY_URL: url(),
	VALKEY_CONNECT_TIMEOUT_MS: int({ min: 100, default: 2000 }),

	// Signs sessions and tokens; no default, since a shared one would be a known key.
	AUTH_SECRET: str({ minLength: 32 }),
	// Where clients reach the API: the origin in verification links and OAuth callbacks.
	AUTH_BASE_URL: url('http://127.0.0.1:4600'),
	// Closed by default: nobody can register, by password or through Google.
	SIGNUP_ENABLED: bool(false),
	// Both or neither, checked in `assertEnvSafe`.
	GOOGLE_CLIENT_ID: v.optional(v.string()),
	GOOGLE_CLIENT_SECRET: v.optional(v.string()),
	// The only places a native sign-in may send the browser back to.
	NATIVE_REDIRECT_URIS: list('starter://auth/callback'),
	// A native sign-in's browser round trip to Google, and the one-time code that ends it.
	NATIVE_FLOW_TTL_S: int({ min: 60, default: 600 }),
	NATIVE_CODE_TTL_S: int({ min: 10, max: 300, default: 60 }),
	// Sign-in and sign-up attempts per client address: a burst of MAX, refilled over the window.
	AUTH_RATE_LIMIT_MAX: int({ min: 1, default: 5 }),
	AUTH_RATE_LIMIT_WINDOW_S: int({ min: 1, default: 60 }),
	// A rate-limit decision slower than this lets the request through (the limiter fails open).
	RATE_LIMIT_TIMEOUT_MS: int({ min: 10, default: 500 }),
	MAIL_TRANSPORT: oneOfEnv(MAIL_TRANSPORTS, 'log'),

	OTEL_SERVICE_NAME: str({ default: 'starter-api' }),
	OBSERVABILITY_LEVEL: oneOfEnv(OBSERVABILITY_LEVELS, DEFAULT_OBSERVABILITY_LEVEL),
	TRACE_SAMPLE_RATIO: ratio(DEFAULT_TRACE_SAMPLE_RATIO),

	// Mounts routes that exist to provoke failures (a slow request); never on in production.
	DEBUG_ROUTES: bool(false),
});

export type Env = v.InferOutput<typeof Env>;

/**
 * Startup check: the pre-stop wait, the one drain window and the pool's close must all fit inside
 * the shutdown deadline, since `stop` runs them one after another; and a request's own waits (a
 * readiness probe, a rate-limit decision) must fit inside the request's deadline.
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
	assertNestedBudget(
		'HEALTH_CHECK_TIMEOUT_MS',
		env.HEALTH_CHECK_TIMEOUT_MS,
		env.REQUEST_TIMEOUT_MS,
	);
	assertNestedBudget('RATE_LIMIT_TIMEOUT_MS', env.RATE_LIMIT_TIMEOUT_MS, env.REQUEST_TIMEOUT_MS);
}

/** Startup check: settings that are fine on a laptop and wrong in production. */
export function assertEnvSafe(env: Env): void {
	if (env.DEBUG_ROUTES && env.NODE_ENV === 'production') {
		throw new Error(
			'Invalid environment configuration:\n  DEBUG_ROUTES=true is not allowed when NODE_ENV=production.',
		);
	}
	if (!env.GOOGLE_CLIENT_ID !== !env.GOOGLE_CLIENT_SECRET) {
		throw new Error(
			'Invalid environment configuration:\n  GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together.',
		);
	}
	// The log mailer writes verification links into the log: fine on a laptop, a leak in production.
	if (env.MAIL_TRANSPORT === 'log' && env.NODE_ENV === 'production') {
		throw new Error(
			'Invalid environment configuration:\n  MAIL_TRANSPORT=log is not allowed when NODE_ENV=production.',
		);
	}
}
