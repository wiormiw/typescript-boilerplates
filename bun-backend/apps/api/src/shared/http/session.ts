import type { Context } from 'hono';
import { Unauthenticated } from '@starter/lib/errors';
import type { AppEnv, AuthenticatedSession } from '#src/shared/http/types.ts';

/** The caller's session; throws Unauthenticated (401) when the request has none. */
export function requireUser<E extends AppEnv>(c: Context<E>): AuthenticatedSession {
	const session = c.get('session');
	if (!session) throw new Unauthenticated();
	return session;
}
