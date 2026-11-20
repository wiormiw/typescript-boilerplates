import { Hono } from 'hono';
import { SleepQuery } from '@starter/contracts';
import { untilAborted } from '@starter/lib/abort';
import { notFound, problemHandler } from '#src/middleware/error-handler.ts';
import { requestContext } from '#src/middleware/request-context.ts';
import { bodyCeiling, securityHeaders } from '#src/middleware/security.ts';
import { session } from '#src/middleware/session.ts';
import { queryParams } from '#src/middleware/validate.ts';
import type { AppEnv } from '#src/shared/http/types.ts';
import type { AppDeps } from '#src/bootstrap/types.ts';

/** The HTTP surface: cross-cutting middleware around the routes. */
export function createApp(deps: AppDeps): Hono<AppEnv> {
	const app = new Hono<AppEnv>()
		.use(
			requestContext({
				budgetMs: deps.budgetMs,
				logger: deps.logger,
				lifecycle: deps.lifecycle,
				service: 'starter',
			}),
		)
		.use(securityHeaders)
		.use(bodyCeiling(deps.maxBodyBytes))
		.use(session(deps.authenticate));
	for (const module of deps.modules) app.route('/', module.routes);

	if (deps.debugRoutes) {
		// Lets a test hold a request open to watch the deadline, a disconnect or a drain act on it.
		app.get('/_debug/sleep', queryParams(SleepQuery), async (c) => {
			const { ms } = c.req.valid('query');
			await untilAborted(Bun.sleep(ms), c.var.signal);
			return c.json({ slept: ms });
		});
	}

	app.onError(
		problemHandler({
			logger: deps.logger,
			shutdown: deps.lifecycle.signal,
			retryAfterS: deps.shutdownRetryAfterS,
		}),
	);
	app.notFound(notFound);
	return app;
}
