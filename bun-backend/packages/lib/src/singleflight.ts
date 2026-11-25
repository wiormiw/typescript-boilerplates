export interface SingleflightOptions {
	/** Aborting it aborts every flight and rejects its callers (process shutdown). */
	lifecycle?: AbortSignal;
}

interface Flight {
	promise: Promise<unknown>;
	/** What the shared work runs under: aborted when every caller has gone or the lifecycle fires. */
	control: AbortController;
	callers: number;
}

/**
 * Coalesces concurrent calls for one key into one run of the work (a cache stampede, a herd of
 * identical requests). Each caller keeps its own signal: aborting it rejects that caller alone and
 * the others still get the answer. The work runs under a signal of its own, aborted only when the
 * last caller has gone or the lifecycle signal fires, so one impatient client cannot cancel work
 * others wait on. A flight is forgotten when it settles, and also when its last caller leaves, so a
 * caller arriving after that starts a fresh run instead of joining one that is being cancelled.
 *
 * A failure is shared like an answer. The class holds the map of flights across calls.
 */
export class Singleflight {
	#flights = new Map<string, Flight>();
	#lifecycle: AbortSignal | undefined;

	constructor(options: SingleflightOptions = {}) {
		this.#lifecycle = options.lifecycle;
	}

	/** Flights in progress. */
	get size(): number {
		return this.#flights.size;
	}

	run<T>(key: string, work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
		if (signal.aborted) return Promise.reject(signal.reason);
		let flight = this.#flights.get(key);
		if (flight === undefined) flight = this.#start(key, work);
		const joined = flight;
		joined.callers++;
		return new Promise<T>((resolve, reject) => {
			const leave = () => {
				signal.removeEventListener('abort', onCaller);
				joined.control.signal.removeEventListener('abort', onWork);
			};
			const onCaller = () => {
				leave();
				joined.callers--;
				if (joined.callers === 0) {
					// Nobody waits any more: stop the work, and let the next caller begin anew.
					if (this.#flights.get(key) === joined) this.#flights.delete(key);
					joined.control.abort(signal.reason);
				}
				reject(signal.reason);
			};
			const onWork = () => {
				leave();
				reject(joined.control.signal.reason);
			};
			signal.addEventListener('abort', onCaller, { once: true });
			joined.control.signal.addEventListener('abort', onWork, { once: true });
			joined.promise.then(
				(value) => {
					leave();
					resolve(value as T);
				},
				(error: unknown) => {
					leave();
					reject(error);
				},
			);
		});
	}

	#start<T>(key: string, work: (signal: AbortSignal) => Promise<T>): Flight {
		const control = new AbortController();
		const lifecycle = this.#lifecycle;
		const onLifecycle = () => control.abort(lifecycle?.reason);
		if (lifecycle?.aborted) onLifecycle();
		else lifecycle?.addEventListener('abort', onLifecycle, { once: true });
		// A synchronous throw in `work` is a rejection like any other.
		const promise = new Promise<T>((resolve) => resolve(work(control.signal)));
		const flight: Flight = { promise, control, callers: 0 };
		this.#flights.set(key, flight);
		const settled = () => {
			lifecycle?.removeEventListener('abort', onLifecycle);
			if (this.#flights.get(key) === flight) this.#flights.delete(key);
		};
		// Every caller handles the rejection; this one only keeps it from being unhandled when all left.
		promise.then(settled, settled);
		return flight;
	}
}
