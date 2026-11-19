// Retry with exponential backoff and full jitter, abort-aware.
// delay = random(0, min(cap, base * 2^attempt))   (AWS "Exponential Backoff And Jitter")

import { setTimeout as sleep } from 'node:timers/promises';

export interface RetryOptions {
	/** Total attempts, including the first one. */
	readonly attempts: number;
	readonly baseMs: number;
	readonly capMs: number;
	/** Return true only for transient failures: timeouts, 429, 502/503/504, deadlocks, ECONNRESET. */
	readonly isRetryable: (error: unknown) => boolean;
	/** Server hint (Retry-After) in ms. It has priority over the computed delay. */
	readonly retryAfterMs?: (error: unknown) => number | undefined;
	readonly signal?: AbortSignal;
	readonly random?: () => number;
	readonly onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export function fullJitterDelay(
	attempt: number,
	baseMs: number,
	capMs: number,
	random: () => number = Math.random,
): number {
	return Math.floor(random() * Math.min(capMs, baseMs * 2 ** attempt));
}

export async function retry<T>(
	fn: (attempt: number, signal: AbortSignal | undefined) => Promise<T>,
	opts: RetryOptions,
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		opts.signal?.throwIfAborted();
		try {
			return await fn(attempt, opts.signal);
		} catch (error) {
			const last = attempt + 1 >= opts.attempts;
			if (last || opts.signal?.aborted || !opts.isRetryable(error)) throw error;

			const delayMs =
				opts.retryAfterMs?.(error) ??
				fullJitterDelay(attempt, opts.baseMs, opts.capMs, opts.random);
			opts.onRetry?.({ attempt, delayMs, error });
			// The wait ends the moment the signal aborts, and the caller sees the signal's own reason.
			try {
				await sleep(delayMs, undefined, opts.signal ? { signal: opts.signal } : {});
			} catch (waitError) {
				if (opts.signal?.aborted) throw opts.signal.reason;
				throw waitError;
			}
		}
	}
}
