import type { Clock } from '@starter/lib/time';
import type { RateLimitStore } from '#src/infra/types.ts';

/** An in-memory token bucket with the Valkey script's arithmetic, on an injectable clock. */
export function memoryRateLimit(clock: Clock): RateLimitStore {
	const buckets = new Map<string, { tokens: number; at: number }>();
	return {
		async consume(key, { window, max }) {
			const now = clock.now().epochMilliseconds;
			const rate = max / (window * 1000);
			const held = buckets.get(key);
			const fresh = !held || now - held.at >= window * 1000;
			const before = fresh ? max : Math.min(max, held.tokens + (now - held.at) * rate);
			if (before >= 1) {
				buckets.set(key, { tokens: before - 1, at: now });
				return { allowed: true, retryAfter: null };
			}
			buckets.set(key, { tokens: before, at: now });
			return { allowed: false, retryAfter: Math.max(1, Math.ceil((1 - before) / rate / 1000)) };
		},
	};
}

/** A store that lets everything through: for tests that are not about rate limiting. */
export const unlimited: RateLimitStore = {
	consume: async () => ({ allowed: true, retryAfter: null }),
};
