// Minimal circuit breaker: closed -> open (after N consecutive failures) -> half-open (after reset
// timeout, lets a few probe calls through) -> closed on success / open on failure.

import { isAbortError } from './abort.ts';

export const BREAKER_STATES = ['closed', 'open', 'half-open'] as const;
export type BreakerState = (typeof BREAKER_STATES)[number];

export interface BreakerOptions {
	readonly failureThreshold: number;
	readonly resetTimeoutMs: number;
	readonly halfOpenMaxCalls?: number;
	/** Count only dependency failures (timeouts, 5xx). A 404 or 422 shows the dependency is healthy. */
	readonly isFailure?: (error: unknown) => boolean;
	readonly now?: () => number;
	readonly onStateChange?: (from: BreakerState, to: BreakerState) => void;
}

export class CircuitOpenError extends Error {
	override readonly name = 'CircuitOpenError';
	readonly retryAtMs: number;
	constructor(retryAtMs: number) {
		super('Circuit is open');
		this.retryAtMs = retryAtMs;
	}
}

export class CircuitBreaker {
	#state: BreakerState = 'closed';
	#failures = 0;
	#openedAt = 0;
	#halfOpenInFlight = 0;
	readonly #opts: Required<Omit<BreakerOptions, 'onStateChange'>> &
		Pick<BreakerOptions, 'onStateChange'>;

	constructor(opts: BreakerOptions) {
		this.#opts = {
			halfOpenMaxCalls: 1,
			isFailure: () => true,
			now: Date.now,
			...opts,
		};
	}

	get state(): BreakerState {
		return this.#state;
	}

	async exec<T>(fn: () => Promise<T>): Promise<T> {
		const { now, resetTimeoutMs, halfOpenMaxCalls, isFailure } = this.#opts;

		if (this.#state === 'open') {
			const retryAt = this.#openedAt + resetTimeoutMs;
			if (now() < retryAt) throw new CircuitOpenError(retryAt);
			this.#transition('half-open');
		}

		const probing = this.#state === 'half-open';
		if (probing) {
			if (this.#halfOpenInFlight >= halfOpenMaxCalls) {
				throw new CircuitOpenError(this.#openedAt + resetTimeoutMs);
			}
			this.#halfOpenInFlight++;
		}

		try {
			const value = await fn();
			this.#onSuccess();
			return value;
		} catch (error) {
			// The caller giving up says nothing about the dependency, so it counts neither way.
			if (isAbortError(error)) throw error;
			if (isFailure(error)) this.#onFailure();
			else this.#onSuccess();
			throw error;
		} finally {
			if (probing) this.#halfOpenInFlight--;
		}
	}

	#onSuccess(): void {
		this.#failures = 0;
		if (this.#state !== 'closed') this.#transition('closed');
	}

	#onFailure(): void {
		this.#failures++;
		if (this.#state === 'half-open' || this.#failures >= this.#opts.failureThreshold) {
			this.#openedAt = this.#opts.now();
			if (this.#state !== 'open') this.#transition('open');
		}
	}

	#transition(to: BreakerState): void {
		const from = this.#state;
		this.#state = to;
		this.#opts.onStateChange?.(from, to);
	}
}
