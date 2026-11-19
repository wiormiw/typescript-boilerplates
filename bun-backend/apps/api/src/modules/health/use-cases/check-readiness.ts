import type { CheckReadinessDeps, Readiness } from '#src/modules/health/health.types.ts';

/**
 * Whether the process should receive traffic. Starting counts as not ready: nothing should be
 * routed here before the resources are up. A dependency going bad is logged here, which the wire
 * hides on purpose (flags only), and on a change per check, not on every probe: a probe every few
 * seconds would otherwise repeat the same line for the whole outage.
 */
export async function checkReadiness(
	deps: CheckReadinessDeps,
	signal: AbortSignal,
): Promise<Readiness> {
	if (!deps.lifecycle.isReady()) return { status: 'draining', flags: {} };

	const log = deps.logger.child({ component: 'readiness' });
	// Absent from `failing` means "not seen yet", which counts as healthy so a healthy start logs nothing.
	const transition = (name: string, ok: boolean, onFail: () => void) => {
		if (ok && deps.failing.delete(name)) log.info({ check: name }, 'readiness check recovered');
		else if (!ok && !deps.failing.has(name)) {
			deps.failing.add(name);
			onFail();
		}
	};

	let results;
	try {
		results = await deps.checks(signal);
	} catch (error) {
		transition('(checks)', false, () => log.error({ err: error }, 'readiness checks threw'));
		// Unknown health is not health.
		return { status: 'degraded', flags: {} };
	}
	transition('(checks)', true, () => {});
	for (const [name, result] of Object.entries(results)) {
		transition(name, result.ok, () =>
			log.warn({ check: name, detail: result.detail }, 'readiness check failing'),
		);
	}
	const flags = Object.fromEntries(Object.entries(results).map(([name, r]) => [name, r.ok]));
	return { status: Object.values(flags).every(Boolean) ? 'ready' : 'degraded', flags };
}
