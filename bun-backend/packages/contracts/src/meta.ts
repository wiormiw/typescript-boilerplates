import * as v from 'valibot';

export const HealthView = v.object({ status: v.literal('ok') });
export type HealthView = v.InferOutput<typeof HealthView>;

/**
 * How ready the process is: `degraded` when a dependency check fails, `draining` when it is not
 * taking traffic (starting or stopping).
 */
export const ReadinessStatus = v.picklist(['ready', 'draining', 'degraded']);
export type ReadinessStatus = v.InferOutput<typeof ReadinessStatus>;

/** One boolean per dependency check beside the status, so the set can grow without a contract bump. */
export const ReadinessView = v.looseObject({ status: ReadinessStatus });
export type ReadinessView = v.InferOutput<typeof ReadinessView>;
