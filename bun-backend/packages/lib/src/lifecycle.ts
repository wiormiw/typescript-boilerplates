import type { Logger } from './log.ts';

export type Phase = 'starting' | 'ready' | 'draining' | 'stopped';

export interface SignalOptions {
	shutdown: (reason: string) => Promise<void>;
	/** After this, exit whether or not shutdown finished. */
	hardExitMs: number;
	logger: Logger;
	exit?: (code: number) => void;
	on?: (signal: string, listener: (...args: unknown[]) => void) => void;
}

export interface HealthResult {
	ok: boolean;
	detail?: string;
}

/** Something the container builds that may need starting, draining, health-checking and release. */
export interface Resource extends AsyncDisposable {
	readonly name: string;
	start?(signal: AbortSignal): Promise<void>;
	drain?(signal: AbortSignal): Promise<void>;
	check?(signal: AbortSignal): Promise<HealthResult>;
}

/**
 * Where the process is in its life, and the root signal every long-running loop watches. It
 * doesn't own teardown: the container disposes what it built, in reverse. This only says when.
 */
export class Lifecycle {
	#log: Logger;
	#root = new AbortController();
	#phase: Phase = 'starting';

	constructor(logger: Logger) {
		this.#log = logger.child({ component: 'lifecycle' });
	}

	/** Aborts when `abort` is called; every long-running loop watches it. */
	get signal(): AbortSignal {
		return this.#root.signal;
	}

	phase(): Phase {
		return this.#phase;
	}

	isReady(): boolean {
		return this.#phase === 'ready';
	}

	isAlive(): boolean {
		return this.#phase !== 'stopped';
	}

	markReady(): void {
		this.#phase = 'ready';
		this.#log.info('ready');
	}

	/** Readiness fails from here; requests in flight carry on. */
	beginDraining(reason: string): void {
		if (this.#phase === 'draining' || this.#phase === 'stopped') return;
		this.#phase = 'draining';
		this.#log.info({ reason }, 'draining');
	}

	/** Tells everything still running to stop. */
	abort(reason: string): void {
		if (!this.#root.signal.aborted) this.#root.abort(new Error(`shutting down: ${reason}`));
	}

	markStopped(): void {
		this.#phase = 'stopped';
		this.#log.info('stopped');
	}

	/** Aborts on shutdown, on timeout, or on any of the given signals. */
	linkedSignal(timeoutMs: number, ...signals: (AbortSignal | undefined)[]): AbortSignal {
		return AbortSignal.any([
			this.#root.signal,
			AbortSignal.timeout(timeoutMs),
			...signals.filter((s): s is AbortSignal => s !== undefined),
		]);
	}
}

/**
 * `value`, released by `release` when its owner disposes it. For things the container builds.
 * A value that is already disposable keeps its own disposal: this one runs it first, then
 * `release`. Disposal happens once; later calls return the first one's promise.
 */
export function owned<T extends object>(
	value: T,
	release: () => Promise<void> | void,
): T & AsyncDisposable {
	const previous = (value as Partial<AsyncDisposable>)[Symbol.asyncDispose]?.bind(value);
	let disposal: Promise<void> | undefined;
	return Object.assign(value, {
		[Symbol.asyncDispose]() {
			disposal ??= (async () => {
				await previous?.();
				await release();
			})();
			return disposal;
		},
	});
}

/**
 * The one place process signals are handled. The first SIGTERM or SIGINT shuts down and exits 0;
 * a second, or the hard deadline, exits 1 at once. A crash shuts down and exits 1.
 */
export function handleSignals(options: SignalOptions): void {
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const on =
		options.on ??
		((signal: string, listener: (...args: unknown[]) => void) => {
			process.on(signal, listener);
		});
	const log = options.logger.child({ component: 'lifecycle' });
	let stopping = false;

	const stop = (reason: string, code: number) => {
		if (stopping) {
			log.warn({ reason }, 'second signal, exiting now');
			exit(1);
			return;
		}
		stopping = true;
		setTimeout(() => {
			log.error('shutdown exceeded its deadline, exiting');
			exit(1);
		}, options.hardExitMs).unref();
		options.shutdown(reason).then(
			() => exit(code),
			(error: unknown) => {
				log.error({ err: error }, 'shutdown failed');
				exit(1);
			},
		);
	};

	on('SIGTERM', () => stop('SIGTERM', 0));
	on('SIGINT', () => stop('SIGINT', 0));
	// A crash arrives with its error, which is logged before shutdown starts.
	on('unhandledRejection', (error) => {
		log.fatal({ err: error }, 'unhandled rejection');
		stop('unhandledRejection', 1);
	});
	on('uncaughtException', (error) => {
		log.fatal({ err: error }, 'uncaught exception');
		stop('uncaughtException', 1);
	});
}

/**
 * Resources in startup order. Drain and disposal run in reverse, so what was built last goes
 * first. Disposal keeps going past a failure (a consumer left running would be cut off when its
 * broker closes) and throws the failures afterwards, like `releaseAll` in akashic.
 */
export class ResourceStack implements AsyncDisposable {
	#stack = new AsyncDisposableStack();
	#resources: Resource[] = [];
	#disposal: Promise<void> | undefined;
	#closed = false;

	/**
	 * Starts the resource, then keeps it. One that fails to start is not kept, nor disposed. Await
	 * adds in sequence: the order they complete in is the order they are disposed in.
	 */
	async add<R extends Resource>(resource: R, signal: AbortSignal): Promise<R> {
		signal.throwIfAborted();
		if (this.#closed) throw new Error(`cannot add ${resource.name}: the stack is disposed`);
		await resource.start?.(signal);
		if (this.#closed) {
			// Disposal began while it was starting and has already taken its snapshot.
			await resource[Symbol.asyncDispose]();
			throw new Error(`${resource.name} started after the stack was disposed`);
		}
		this.#resources.push(resource);
		return resource;
	}

	async drainAll(signal: AbortSignal): Promise<void> {
		const failures: unknown[] = [];
		for (const resource of this.#resources.toReversed()) {
			try {
				await resource.drain?.(signal);
			} catch (error) {
				failures.push(error);
			}
		}
		throwFailures(failures, 'several could not be drained');
	}

	async checkAll(signal: AbortSignal): Promise<Record<string, HealthResult>> {
		const checked = this.#resources.filter((resource) => resource.check !== undefined);
		const results = await Promise.all(
			checked.map(async (resource): Promise<HealthResult> => {
				try {
					return await resource.check!(signal);
				} catch (error) {
					return { ok: false, detail: error instanceof Error ? error.message : String(error) };
				}
			}),
		);
		return Object.fromEntries(checked.map((resource, i) => [resource.name, results[i]!]));
	}

	names(): readonly string[] {
		return this.#resources.map((resource) => resource.name);
	}

	[Symbol.asyncDispose](): Promise<void> {
		this.#closed = true;
		this.#disposal ??= this.#dispose();
		return this.#disposal;
	}

	async #dispose(): Promise<void> {
		const failures: unknown[] = [];
		for (const resource of this.#resources) {
			this.#stack.defer(async () => {
				try {
					await resource[Symbol.asyncDispose]();
				} catch (error) {
					failures.push(error);
				}
			});
		}
		await this.#stack.disposeAsync();
		throwFailures(failures, 'several could not be released');
	}
}

function throwFailures(failures: unknown[], message: string): void {
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, message);
}
