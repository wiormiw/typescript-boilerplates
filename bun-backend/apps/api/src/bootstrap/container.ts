import { Container } from '@inferdi/inferdi';
import { BunSqlDatabase } from '@starter/db';
import { createLifecycle } from '@starter/lib/lifecycle';
import { createLogger } from '@starter/lib/log';
import { createTelemetry } from '@starter/lib/telemetry';
import { systemClock, type Clock } from '@starter/lib/time';
import type { Env } from '#src/bootstrap/config.ts';
import { RuntimeMetrics } from '#src/infra/runtime-metrics.ts';
import { Valkey } from '#src/infra/valkey.ts';

/**
 * The composition root: the only place that constructs things, and the only file that imports
 * InferDI. Nothing here connects or starts; the runtime resolves in startup order and starts
 * each resource, and disposal releases in reverse.
 */
export function buildContainer(env: Env) {
	return new Container()
		.registerValue('env', env)
		.registerValue('clock', systemClock as Clock)
		.registerFactory('telemetry', () =>
			createTelemetry({
				serviceName: env.OTEL_SERVICE_NAME,
				environment: env.NODE_ENV,
				endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
				protocol: env.OTEL_EXPORTER_OTLP_PROTOCOL,
				metricIntervalMs: env.OTEL_METRIC_INTERVAL_MS,
				level: env.OBSERVABILITY_LEVEL,
				traceSampleRatio: env.TRACE_SAMPLE_RATIO,
			}),
		)
		.registerFactory('logger', (c) =>
			createLogger({
				otelLogger: c.get('telemetry').logger,
				level: env.LOG_LEVEL,
				service: env.OTEL_SERVICE_NAME,
				environment: env.NODE_ENV,
			}),
		)
		.registerFactory('lifecycle', (c) => createLifecycle(c.get('logger')))
		.registerFactory('database', (c) =>
			BunSqlDatabase.create({
				url: env.DATABASE_URL,
				poolMax: env.DB_POOL_MAX,
				idleTimeoutS: env.DB_IDLE_TIMEOUT_S,
				connectTimeoutS: env.DB_CONNECT_TIMEOUT_S,
				closeTimeoutS: env.DB_CLOSE_TIMEOUT_S,
				slowQueryMs: env.DB_SLOW_QUERY_MS,
				limits: {
					statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
					lockTimeoutMs: env.DB_LOCK_TIMEOUT_MS,
					idleInTransactionTimeoutMs: env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
				},
				logger: c.get('logger'),
			}),
		)
		.registerFactory('valkey', (c) =>
			Valkey.create({
				url: env.VALKEY_URL,
				connectTimeoutMs: env.VALKEY_CONNECT_TIMEOUT_MS,
				logger: c.get('logger'),
			}),
		)
		.registerFactory('runtimeMetrics', () => new RuntimeMetrics());
}
