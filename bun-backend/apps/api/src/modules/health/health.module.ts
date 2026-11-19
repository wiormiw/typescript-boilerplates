import type { Module } from '#src/bootstrap/types.ts';
import type { HealthModuleDeps } from '#src/modules/health/health.types.ts';
import { healthRouter } from '#src/modules/health/router/health.router.ts';

export function createHealthModule(deps: HealthModuleDeps): Module {
	return {
		name: 'health',
		routes: healthRouter(
			{
				lifecycle: deps.lifecycle,
				checks: deps.checks,
				logger: deps.logger,
				failing: new Set(),
			},
			deps.budgetMs,
		),
	};
}
