import { Lifecycle } from '@starter/lib/lifecycle';
import { captureLogger } from '@starter/lib/testing';
import { createApp } from '#src/bootstrap/app.ts';
import type { AppDeps } from '#src/bootstrap/types.ts';
import { createHealthModule } from '#src/modules/health/health.module.ts';
import type { ReadinessChecks } from '#src/modules/health/health.types.ts';
import { defaults } from './env.ts';

/** The HTTP limits `createApp` takes, at their configured defaults. */
export const httpLimits = {
	budgetMs: defaults.REQUEST_TIMEOUT_MS,
	maxBodyBytes: defaults.MAX_REQUEST_BODY_BYTES,
	shutdownRetryAfterS: defaults.SHUTDOWN_RETRY_AFTER_S,
};

type TestAppDeps = Omit<AppDeps, 'modules'> & { checks: ReadinessChecks };

/** An app over a capturing logger, with healthy dependencies unless a test says otherwise. */
export function testApp(overrides: Partial<TestAppDeps> = {}) {
	const { logger, lines } = captureLogger();
	const lifecycle = new Lifecycle(logger);
	lifecycle.markReady();
	const deps: TestAppDeps = {
		logger,
		lifecycle,
		checks: async () => ({ database: { ok: true }, valkey: { ok: true } }),
		...httpLimits,
		debugRoutes: true,
		authenticate: async () => undefined,
		...overrides,
	};
	const app = createApp({
		logger: deps.logger,
		lifecycle: deps.lifecycle,
		modules: [
			createHealthModule({
				lifecycle: deps.lifecycle,
				logger: deps.logger,
				checks: deps.checks,
				budgetMs: deps.budgetMs,
			}),
		],
		authenticate: deps.authenticate,
		budgetMs: deps.budgetMs,
		maxBodyBytes: deps.maxBodyBytes,
		shutdownRetryAfterS: deps.shutdownRetryAfterS,
		debugRoutes: deps.debugRoutes,
	});
	// The lifecycle and logger the app actually uses, which a test may have overridden.
	return { app, lifecycle: deps.lifecycle, lines, logger: deps.logger };
}
