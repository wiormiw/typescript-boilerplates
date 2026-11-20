import type { MiddlewareHandler } from 'hono';
import { requireUser } from '#src/shared/http/session.ts';
import type { AppEnv, Authenticate } from '#src/shared/http/types.ts';

/**
 * Refuses a request without a session (401) before anything after it runs, so a signed-out
 * caller learns that first rather than what was wrong with its body.
 */
export const signedIn: MiddlewareHandler<AppEnv> = async (c, next) => {
	requireUser(c);
	await next();
};

/**
 * Reads the caller's session into `c.var.session`. It never refuses: `requireUser` does, so
 * anonymous routes stay open. Only a request with an `authorization` header is looked up, so
 * probes and anonymous routes cost nothing; cookie sessions are not read here.
 */
export function session(authenticate: Authenticate): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		if (c.req.raw.headers.has('authorization')) {
			c.set('session', await authenticate(c.req.raw.headers, c.var.signal));
		}
		await next();
	};
}
