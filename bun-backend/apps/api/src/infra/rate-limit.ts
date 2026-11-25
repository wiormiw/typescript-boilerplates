import { untilAborted } from '@starter/lib/abort';
import type {
	FailOpenOptions,
	RateLimitDecision,
	RateLimitRule,
	RateLimitStore,
} from '#src/infra/types.ts';
import type { Valkey } from '#src/infra/valkey.ts';

/** The Valkey key namespace of better-auth's sign-in and sign-up buckets. */
export const AUTH_RATE_LIMIT_PREFIX = 'ratelimit:auth:';

/**
 * A token bucket per key: `max` tokens, refilled at `max / window` per second, one taken per
 * request. Bursts up to `max` pass at once; past that, requests pass as tokens refill. The time
 * is Valkey's own (`TIME`), so every API instance measures against one clock. A bucket idle for a
 * whole window is full again, so it expires then.
 *
 * KEYS[1]: the bucket. ARGV[1]: max. ARGV[2]: window in seconds.
 * Returns { allowed (1 or 0), milliseconds until a token is due (0 when allowed) }.
 */
const TOKEN_BUCKET = `
local capacity = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2]) * 1000
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local rate = capacity / window_ms
local state = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(state[1])
local at = tonumber(state[2])
if tokens == nil or at == nil then
  tokens = capacity
  at = now
end
tokens = math.min(capacity, tokens + math.max(0, now - at) * rate)
local allowed = 0
local wait_ms = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  wait_ms = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'at', now)
redis.call('PEXPIRE', KEYS[1], window_ms)
return { allowed, wait_ms }
`;

const TOKEN_BUCKET_SHA = new Bun.CryptoHasher('sha1').update(TOKEN_BUCKET).digest('hex');

/**
 * better-auth's rate-limit storage on Valkey, shared by every API instance. Valkey runs the
 * script atomically, so the check and the take are one step.
 *
 * It fails open: if Valkey errs or is slower than `timeoutMs`, the request passes and a warning
 * is logged. Readiness already fails while Valkey is down, so the instance stops getting traffic;
 * refusing every sign-in meanwhile would turn an outage of the cache into one of the login.
 */
export function createRateLimitStore(
	valkey: Pick<Valkey, 'command'>,
	options: FailOpenOptions,
): RateLimitStore {
	const log = options.logger.child({ component: 'rate-limit' });

	// Valkey forgets loaded scripts on restart, so a NOSCRIPT answer loads it and runs it again.
	async function run(key: string, rule: RateLimitRule, signal: AbortSignal): Promise<unknown> {
		const args = ['1', key, String(rule.max), String(rule.window)];
		try {
			return await untilAborted(
				valkey.command.send('EVALSHA', [TOKEN_BUCKET_SHA, ...args]),
				signal,
			);
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes('NOSCRIPT')) throw error;
			await untilAborted(valkey.command.send('SCRIPT', ['LOAD', TOKEN_BUCKET]), signal);
			return untilAborted(valkey.command.send('EVALSHA', [TOKEN_BUCKET_SHA, ...args]), signal);
		}
	}

	return {
		async consume(key, rule): Promise<RateLimitDecision> {
			try {
				const reply = await run(
					`${options.prefix}${key}`,
					rule,
					AbortSignal.timeout(options.timeoutMs),
				);
				const [allowed, waitMs] = reply as [number, number];
				return allowed === 1
					? { allowed: true, retryAfter: null }
					: { allowed: false, retryAfter: Math.max(1, Math.ceil(waitMs / 1000)) };
			} catch (error) {
				// No key in the line: it holds a client address.
				log.warn({ err: error }, 'rate limit unavailable; request let through');
				return { allowed: true, retryAfter: null };
			}
		},
	};
}
