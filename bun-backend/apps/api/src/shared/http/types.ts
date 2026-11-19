import type { Env as HonoEnv } from 'hono';
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

/** What every request carries, set by middleware before any route runs. */
export interface RequestVariables extends RequestContext {
	/** Aborts on client disconnect, the request deadline, or shutdown. */
	signal: AbortSignal;
}

export interface AppEnv extends HonoEnv {
	Variables: RequestVariables;
}
