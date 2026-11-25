import type { Logger } from '@starter/lib/log';
import type { createAuth } from '#src/infra/auth.ts';

export interface MailMessage {
	to: string;
	subject: string;
	text: string;
}

export interface Mailer {
	send(message: MailMessage, signal: AbortSignal): Promise<void>;
}

export type Auth = ReturnType<typeof createAuth>;

/** A limit as better-auth states it: at most `max` requests per `window` seconds. */
export interface RateLimitRule {
	window: number;
	max: number;
}

/** Whether one request may pass, and if not, how many seconds until one would. */
export interface RateLimitDecision {
	allowed: boolean;
	retryAfter: number | null;
}

/**
 * better-auth's `rateLimit.customStorage`: one atomic check-and-take per request, so concurrent
 * requests cannot all pass a stale read.
 */
export interface RateLimitStore {
	consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision>;
}

/** What `start` remembers about a native sign-in until the browser comes back from Google. */
export interface NativeFlow {
	codeChallenge: string;
	redirectUri: string;
	clientState: string;
}

/** What a one-time code stands for: the session to hand over, if the verifier matches. */
export interface NativeGrant {
	sessionToken: string;
	codeChallenge: string;
	userId: string;
}

/** Flows and codes live briefly and are read once: a take removes what it returns, atomically. */
export interface AuthCodeStore {
	putFlow(id: string, flow: NativeFlow, ttlS: number, signal: AbortSignal): Promise<void>;
	takeFlow(id: string, signal: AbortSignal): Promise<NativeFlow | undefined>;
	putCode(code: string, grant: NativeGrant, ttlS: number, signal: AbortSignal): Promise<void>;
	takeCode(code: string, signal: AbortSignal): Promise<NativeGrant | undefined>;
}

/** What a Valkey-backed cache that fails open is configured with. */
export interface FailOpenOptions {
	/** Prefixes every key, so tests (or a second app) never share entries. */
	prefix: string;
	logger: Logger;
	/** How long one call may wait on Valkey before it is skipped and the request carries on. */
	timeoutMs: number;
}
