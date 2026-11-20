import { websocket } from '@hono/bun';
import { loadEnv } from '@starter/lib/config';
import { handleSignals } from '@starter/lib/lifecycle';
import { assertEnvBudgets, assertEnvSafe, Env } from '#src/bootstrap/config.ts';
import { buildContainer } from '#src/bootstrap/container.ts';
import { listen, start, stop } from '#src/bootstrap/runtime.ts';
import type { Served, Started } from '#src/bootstrap/types.ts';

const env = loadEnv(Env, Bun.env);
assertEnvBudgets(env);
assertEnvSafe(env);

const container = buildContainer(env);
// Created before anything connects, so a signal during startup is handled and telemetry is there
// to be flushed last.
const telemetry = container.get('telemetry');
const logger = container.get('logger');
const lifecycle = container.get('lifecycle');

// Until they exist there is nothing to drain or release.
let server: Served = { stop: async () => {} };
let started: Started | undefined;
let listening = false;
let startup: Promise<void> = Promise.resolve();

handleSignals({
	logger,
	hardExitMs: env.SHUTDOWN_TIMEOUT_MS,
	shutdown: async (reason) => {
		try {
			await stop({
				reason,
				server,
				started,
				lifecycle,
				// Nothing is serving during startup, so there is nobody to wait for.
				preStopMs: listening ? env.PRE_STOP_DELAY_MS : 0,
				drainMs: env.DRAIN_TIMEOUT_MS,
			});
			// A shutdown during startup aborts it; wait for `start` to release what it built.
			await startup;
		} finally {
			await telemetry[Symbol.asyncDispose]();
		}
	},
});

// A signal during startup has begun shutdown already, and the signal handler exits.
const signalled = () => lifecycle.phase() !== 'starting';

startup = (async () => {
	try {
		const up = await start(container);
		if (signalled()) {
			// Shutdown began as `start` finished, and its `stop` saw no stack to release.
			await up.resources[Symbol.asyncDispose]();
			return;
		}
		started = up;
		server = await listen({
			serve: () =>
				Bun.serve({
					port: env.PORT,
					fetch: up.app.fetch,
					websocket,
					maxRequestBodySize: env.MAX_REQUEST_BODY_BYTES,
				}),
			started: up,
		});
		listening = true;
	} catch (error) {
		if (signalled()) return;
		logger.fatal({ err: error }, 'startup failed');
		await Promise.resolve(telemetry[Symbol.asyncDispose]()).catch(() => undefined);
		process.exit(1);
	}
	if (!signalled()) {
		lifecycle.markReady();
		logger.info({ port: env.PORT }, 'listening');
	}
})();
await startup;
