import type { Env as HonoEnv } from 'hono';
import type { UserView } from '@starter/contracts';
import type { Lifecycle } from '@starter/lib/lifecycle';
import type { Logger } from '@starter/lib/log';

/** What the HTTP layer takes from the process: a logger, the lifecycle, and the request deadline. */
export interface HttpDeps {
	logger: Logger;
	lifecycle: Lifecycle;
	/** How long one request may take before its signal aborts. */
	budgetMs: number;
}

/** What ties a log line and a span to one request, on its async context and on `c.var`. */
export interface RequestContext {
	requestId: string;
	/** The server span's trace id; unset when the request is untraced. */
	traceId?: string | undefined;
	/** Carries the request id on every line. */
	logger: Logger;
}

/** Who is calling: the user and the session that proved it. */
export interface AuthenticatedSession {
	user: UserView;
	sessionId: string;
}

/** Resolves request headers to a session, or undefined when they do not identify one. */
export type Authenticate = (
	headers: Headers,
	signal: AbortSignal,
) => Promise<AuthenticatedSession | undefined>;

/** What every request carries, set by middleware before any route runs. */
export interface RequestVariables extends RequestContext {
	/** Aborts on client disconnect, the request deadline, or shutdown. */
	signal: AbortSignal;
	/** Set by the session middleware when the request carries a valid bearer token. */
	session?: AuthenticatedSession | undefined;
}

export interface AppEnv extends HonoEnv {
	Variables: RequestVariables;
}
