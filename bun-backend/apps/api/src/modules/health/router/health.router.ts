import { Hono } from 'hono';
import { HealthView, ReadinessView } from '@starter/contracts';
import type { CheckReadinessDeps } from '#src/modules/health/health.types.ts';
import { checkReadiness } from '#src/modules/health/use-cases/check-readiness.ts';
import type { AppEnv } from '#src/shared/http/types.ts';
import { reply } from '#src/shared/http/reply.ts';

/**
 * `/healthz` while the process runs, and never touches a dependency: a database blip must not get
 * the process restarted. `/readyz` once started, and while every dependency check passes.
 */
export function healthRouter(deps: CheckReadinessDeps, budgetMs: number) {
	return new Hono<AppEnv>()
		.get('/healthz', (c) => reply(c, HealthView, { status: 'ok' }))
		.get('/readyz', async (c) => {
			const { status, flags } = await checkReadiness(deps, deps.lifecycle.linkedSignal(budgetMs));
			// The status goes last, so a check named `status` can't overwrite it.
			return reply(c, ReadinessView, { ...flags, status }, status === 'ready' ? 200 : 503);
		});
}
