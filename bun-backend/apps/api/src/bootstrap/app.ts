import { Hono } from 'hono';
import * as v from 'valibot';
import { MAX_DEBUG_SLEEP_MS, SleepQuery } from '@starter/contracts';
import { ValidationFailed } from '@starter/lib/errors';
import { untilAborted } from '@starter/lib/abort';
import { notFound, problemHandler } from '#src/middleware/error-handler.ts';
import { requestContext } from '#src/middleware/request-context.ts';
import { bodyCeiling, securityHeaders } from '#src/middleware/security.ts';
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
		.use((c, next) => bodyCeiling(c, next));
	for (const module of deps.modules) app.route('/', module.routes);

	if (deps.debugRoutes) {
		// Lets a test hold a request open to watch the deadline, a disconnect or a drain act on it.
		app.get('/_debug/sleep', async (c) => {
			const query = v.safeParse(SleepQuery, { ms: c.req.query('ms') });
			if (!query.success) {
				throw new ValidationFailed(`ms must be an integer from 0 to ${MAX_DEBUG_SLEEP_MS}.`);
			}
			await untilAborted(Bun.sleep(query.output.ms), c.var.signal);
			return c.json({ slept: query.output.ms });
		});
	}

	app.onError(problemHandler(deps.logger, deps.lifecycle.signal));
	app.notFound(notFound);
	return app;
}
