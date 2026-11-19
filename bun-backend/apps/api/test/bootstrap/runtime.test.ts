import { describe, expect, test } from 'bun:test';
import { loadEnv } from '@starter/lib/config';
import { ResourceStack, type Lifecycle, type Resource } from '@starter/lib/lifecycle';
import { captureLogger } from '@starter/lib/testing';
import { Env } from '#src/bootstrap/config.ts';
import type { AppContainer } from '#src/bootstrap/types.ts';
import { start, stop } from '#src/bootstrap/runtime.ts';
import type { Started } from '#src/bootstrap/types.ts';

const env = loadEnv(Env, {
	DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
	VALKEY_URL: 'redis://127.0.0.1:1',
	OBSERVABILITY_LEVEL: 'off',
});

/** A resource that writes what happens to it into `events`. */
function fakeResource(name: string, events: string[], failStart = false): Resource {
	return {
		name,
		async start() {
			events.push(`start ${name}`);
			if (failStart) throw new Error(`${name} unreachable`);
		},
		async drain() {
			events.push(`drain ${name}`);
		},
		async [Symbol.asyncDispose]() {
			events.push(`dispose ${name}`);
		},
	};
}

function fakeContainer(events: string[], failing?: string) {
	const { logger } = captureLogger();
	const values = {
		env,
		logger,
		lifecycle: {
			signal: new AbortController().signal,
			linkedSignal: () => new AbortController().signal,
		},
		runtimeMetrics: fakeResource('runtime-metrics', events, failing === 'runtime-metrics'),
		database: fakeResource('database', events, failing === 'database'),
		valkey: fakeResource('valkey', events, failing === 'valkey'),
	};
	return {
		get: (key: keyof typeof values) => values[key],
	} as unknown as Pick<AppContainer, 'get'>;
}

describe('start', () => {
	test('adds resources in order runtime-metrics, database, valkey', async () => {
		const events: string[] = [];
		const started = await start(fakeContainer(events));
		expect(started.resources.names()).toEqual(['runtime-metrics', 'database', 'valkey']);
		expect(events.filter((e) => e.startsWith('start'))).toEqual([
			'start runtime-metrics',
			'start database',
			'start valkey',
		]);
		await started.resources[Symbol.asyncDispose]();
	});

	test('a failing database start disposes runtime-metrics and rethrows', async () => {
		const events: string[] = [];
		await expect(start(fakeContainer(events, 'database'))).rejects.toThrow('database unreachable');
		expect(events).toContain('dispose runtime-metrics');
		// valkey is never reached
		expect(events).not.toContain('start valkey');
	});
});

function fakeLifecycle(events: string[]) {
	return {
		beginDraining: () => void events.push('beginDraining'),
		abort: () => void events.push('abort'),
		markStopped: () => void events.push('markStopped'),
	} satisfies Pick<Lifecycle, 'beginDraining' | 'abort' | 'markStopped'>;
}

function fakeStarted(events: string[]): Started {
	const { logger } = captureLogger();
	const resources = new ResourceStack();
	void resources.add(fakeResource('database', events), new AbortController().signal);
	return { resources, logger } as unknown as Started;
}

describe('stop', () => {
	test('runs beginDraining, then server.stop, then drainAll, then dispose, in that order', async () => {
		const events: string[] = [];
		const started = fakeStarted(events);
		await Bun.sleep(0);
		events.length = 0;
		await stop({
			reason: 'SIGTERM',
			server: { stop: async () => void events.push('server.stop') },
			started,
			lifecycle: fakeLifecycle(events),
			preStopMs: 0,
			drainMs: 1000,
		});
		expect(events).toEqual([
			'beginDraining',
			'server.stop',
			'abort',
			'drain database',
			'dispose database',
			'markStopped',
		]);
	});

	test('resources get only what is left of the one drain window', async () => {
		const events: string[] = [];
		const { logger } = captureLogger();
		const resources = new ResourceStack();
		let sawAbortAfterMs: number | undefined;
		const slow = fakeResource('database', events);
		slow.drain = async (signal) => {
			const began = performance.now();
			if (!signal.aborted)
				await new Promise((resolve) => signal.addEventListener('abort', resolve));
			sawAbortAfterMs = performance.now() - began;
		};
		await resources.add(slow, new AbortController().signal);
		const began = performance.now();
		await stop({
			reason: 'SIGTERM',
			// Takes 150 ms of the 250 ms window, so the drain may have about 100 ms, not 250.
			server: { stop: () => Bun.sleep(150) },
			started: { resources, logger } as unknown as Started,
			lifecycle: fakeLifecycle(events),
			preStopMs: 0,
			drainMs: 250,
		});
		expect(sawAbortAfterMs).toBeLessThan(180);
		expect(performance.now() - began).toBeLessThan(330);
	});

	test('stop forces server.stop(true) when drain exceeds drainMs', async () => {
		const calls: (boolean | undefined)[] = [];
		const server = {
			stop(closeActive?: boolean) {
				calls.push(closeActive);
				return closeActive ? Promise.resolve() : new Promise<void>(() => {});
			},
		};
		const events: string[] = [];
		const began = performance.now();
		await stop({
			reason: 'SIGTERM',
			server,
			started: undefined,
			lifecycle: fakeLifecycle(events),
			preStopMs: 0,
			drainMs: 100,
		});
		expect(calls).toEqual([undefined, true]);
		expect(performance.now() - began).toBeGreaterThanOrEqual(90);
		expect(events).toEqual(['beginDraining', 'abort', 'markStopped']);
	});

	test('a rejecting server.stop still drains, releases and marks stopped', async () => {
		const events: string[] = [];
		const started = fakeStarted(events);
		await Bun.sleep(0);
		events.length = 0;
		await expect(
			stop({
				reason: 'SIGTERM',
				server: { stop: () => Promise.reject(new Error('stop broke')) },
				started,
				lifecycle: fakeLifecycle(events),
				preStopMs: 0,
				drainMs: 1000,
			}),
		).rejects.toThrow('stop broke');
		expect(events).toEqual([
			'beginDraining',
			'abort',
			'drain database',
			'dispose database',
			'markStopped',
		]);
	});

	test('a throwing drainAll still releases and marks stopped', async () => {
		const events: string[] = [];
		const { logger } = captureLogger();
		const resources = new ResourceStack();
		const broken = fakeResource('database', events);
		broken.drain = async () => {
			throw new Error('drain broke');
		};
		await resources.add(broken, new AbortController().signal);
		await expect(
			stop({
				reason: 'SIGTERM',
				server: { stop: async () => {} },
				started: { resources, logger } as unknown as Started,
				lifecycle: fakeLifecycle(events),
				preStopMs: 0,
				drainMs: 1000,
			}),
		).rejects.toThrow('drain broke');
		expect(events).toEqual([
			'start database',
			'beginDraining',
			'abort',
			'dispose database',
			'markStopped',
		]);
	});

	test('a throwing release still marks stopped', async () => {
		const events: string[] = [];
		const { logger } = captureLogger();
		const resources = new ResourceStack();
		const broken = fakeResource('database', events);
		broken[Symbol.asyncDispose] = async () => {
			throw new Error('release broke');
		};
		await resources.add(broken, new AbortController().signal);
		await expect(
			stop({
				reason: 'SIGTERM',
				server: { stop: async () => {} },
				started: { resources, logger } as unknown as Started,
				lifecycle: fakeLifecycle(events),
				preStopMs: 0,
				drainMs: 1000,
			}),
		).rejects.toThrow('release broke');
		expect(events.at(-1)).toBe('markStopped');
	});
});
