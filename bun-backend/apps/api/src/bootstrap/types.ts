import type { Hono } from 'hono';
import type { Lifecycle, ResourceStack } from '@starter/lib/lifecycle';
import type { Logger } from '@starter/lib/log';
import type { buildContainer } from '#src/bootstrap/container.ts';
import type { Env } from '#src/bootstrap/config.ts';
import type { AppEnv, Authenticate, HttpDeps } from '#src/shared/http/types.ts';

/** What a feature module hands the app: a name, and the routes `createApp` mounts at the root. */
export interface Module {
	name: string;
	routes: Hono<AppEnv>;
}

export interface Started {
	app: Hono<AppEnv>;
	resources: ResourceStack;
	env: Env;
	logger: Logger;
	lifecycle: Lifecycle;
}

/** What `listen` and `stop` need of the server. */
export interface Served {
	stop(closeActive?: boolean): Promise<void>;
}

export interface ListenOptions<S extends Served> {
	serve: () => S;
	started: Started;
}

export interface StopOptions {
	reason: string;
	server: Served;
	started: Started | undefined;
	lifecycle: Pick<Lifecycle, 'beginDraining' | 'abort' | 'markStopped'>;
	preStopMs: number;
	drainMs: number;
}

export interface AppDeps extends HttpDeps {
	modules: Module[];
	/** `MAX_REQUEST_BODY_BYTES`: a larger body is refused with a 413 as it streams in. */
	maxBodyBytes: number;
	/** `SHUTDOWN_RETRY_AFTER_S`: the Retry-After on a request cut off by shutdown. */
	shutdownRetryAfterS: number;
	/** Resolves a request's headers to a session; see the session middleware. */
	authenticate: Authenticate;
	/** Mounts routes that provoke failures; off outside tests and local runs. */
	debugRoutes: boolean;
}

export type AppContainer = ReturnType<typeof buildContainer>;
