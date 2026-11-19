import type { ReadinessStatus } from '@starter/contracts';
import type { HealthResult } from '@starter/lib/lifecycle';
import type { HttpDeps } from '#src/shared/http/types.ts';

/** One named check per dependency; the signal bounds the whole round. */
export type ReadinessChecks = (signal: AbortSignal) => Promise<Record<string, HealthResult>>;

export interface HealthModuleDeps extends HttpDeps {
	checks: ReadinessChecks;
}

export interface CheckReadinessDeps extends Pick<
	HealthModuleDeps,
	'lifecycle' | 'checks' | 'logger'
> {
	/** Checks currently reported failing; kept across calls so only a change is logged. */
	failing: Set<string>;
}

/** `flags` is one boolean per check, never a detail: a detail could carry a host or a message. */
export interface Readiness {
	status: ReadinessStatus;
	flags: Record<string, boolean>;
}
