import { ResourceStack } from '@starter/lib/lifecycle';
import type { Logger } from '@starter/lib/log';
import { createApp } from '#src/bootstrap/app.ts';
import type { AppContainer } from '#src/bootstrap/types.ts';
import type { ListenOptions, Served, Started, StopOptions } from '#src/bootstrap/types.ts';
import { createHealthModule } from '#src/modules/health/health.module.ts';

/** Room for each connect timeout to run out and report before the deadline cuts in. */
const STARTUP_SLACK_MS = 2000;

/**
 * The container keys of the resources the stack holds, in startup order. The stack drains and
 * disposes them in reverse, and `/readyz` reports each by its name.
 */
const STARTUP_ORDER = ['runtimeMetrics', 'database', 'valkey'] as const;

/** Disposes the stack and says what it released, so a shutdown that raced startup is visible. */
async function release(stack: ResourceStack, logger: Logger): Promise<void> {
	const resources = [...stack.names()];
	await stack[Symbol.asyncDispose]();
	logger.info({ resources }, 'resources disposed');
}

/**
 * Starts the resources in order, each awaited before the next, then builds the app over them.
 * Telemetry is not here: it is created before this, so signals are handled from the first
 * moment, and it is disposed last by `main`. If a resource fails to start, or shutdown begins
 * while it does, what already started is released before the error propagates.
 */
export async function start(container: Pick<AppContainer, 'get'>): Promise<Started> {
	const env = container.get('env');
	const logger = container.get('logger');
	const lifecycle = container.get('lifecycle');
	const resources = new ResourceStack();
	// Each resource's own connect timeout bounds it; this is the backstop for all of them.
	const signal = lifecycle.linkedSignal(
		env.DB_CONNECT_TIMEOUT_S * 1000 + env.VALKEY_CONNECT_TIMEOUT_MS + STARTUP_SLACK_MS,
	);

	try {
		for (const name of STARTUP_ORDER) {
			const resource = container.get(name);
			try {
				await resources.add(resource, signal);
			} catch (error) {
				// A resource that failed to start is not in the stack, so it is released here.
				await resource[Symbol.asyncDispose]().catch(() => undefined);
				throw error;
			}
			logger.debug({ resource: resource.name }, 'resource started');
		}
		// A signal after the last add has begun shutdown, whose `stop` can't see this stack yet.
		signal.throwIfAborted();

		const app = createApp({
			logger,
			lifecycle,
			modules: [
				createHealthModule({
					lifecycle,
					logger,
					checks: (signal) => resources.checkAll(signal),
					budgetMs: env.REQUEST_TIMEOUT_MS,
				}),
			],
			budgetMs: env.REQUEST_TIMEOUT_MS,
			debugRoutes: env.DEBUG_ROUTES,
		});
		return { app, resources, env, logger, lifecycle };
	} catch (error) {
		try {
			await release(resources, logger);
		} catch (releaseError) {
			logger.error({ err: releaseError }, 'releasing after a failed start failed');
		}
		throw error;
	}
}

/** Starts the server. If it can't (the port is taken), what `start` built is released. */
export async function listen<S extends Served>(options: ListenOptions<S>): Promise<S> {
	const { started } = options;
	try {
		return options.serve();
	} catch (error) {
		started.lifecycle.abort('could not listen');
		await release(started.resources, started.logger);
		throw error;
	}
}

/**
 * Drain, abort, release, in that order. Called once, by the signal handler. Readiness fails at
 * once, but the server keeps accepting for `preStopMs` so a load balancer that has not yet seen
 * that stops sending first. `started` is undefined when shutdown began during startup: `start`
 * releases what it built itself.
 */
export async function stop(options: StopOptions): Promise<void> {
	const { reason, server, started, lifecycle } = options;
	// One drain window, measured once: the server and the resources share it, so the worst case is
	// preStop + drain, however the time is split between them.
	const drainEnd = performance.now() + options.preStopMs + options.drainMs;
	// Whatever fails, the steps after it still run: a resource left open is cut off at exit. The
	// first failure is thrown at the end, the rest are logged.
	const failures: unknown[] = [];
	const attempt = async (work: () => Promise<void>, what: string) => {
		try {
			await work();
		} catch (error) {
			failures.push(error);
			started?.logger.error({ err: error }, `${what} failed`);
		}
	};

	try {
		lifecycle.beginDraining(reason);
		await attempt(async () => {
			await Bun.sleep(options.preStopMs);
			let timer: Timer | undefined;
			const windowClosed = new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), options.drainMs);
			});
			try {
				const drained = await Promise.race([server.stop().then(() => true as const), windowClosed]);
				// Requests still running past the window are cut off, so nothing uses what is released.
				if (!drained) await server.stop(true);
			} finally {
				clearTimeout(timer);
			}
		}, 'stopping the server');

		lifecycle.abort(reason);
		if (started) {
			await attempt(
				() =>
					started.resources.drainAll(
						AbortSignal.timeout(Math.max(0, drainEnd - performance.now())),
					),
				'draining resources',
			);
			await attempt(() => release(started.resources, started.logger), 'releasing resources');
		}
	} finally {
		lifecycle.markStopped();
	}
	if (failures.length > 0) throw failures[0];
}
