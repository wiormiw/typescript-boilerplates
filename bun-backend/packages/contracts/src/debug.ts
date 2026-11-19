import * as v from 'valibot';

/** The longest `/_debug/sleep` will hold a request open. */
export const MAX_DEBUG_SLEEP_MS = 30_000;

/** Query string of `/_debug/sleep`: `ms` arrives as text and leaves as an integer. */
export const SleepQuery = v.object({
	ms: v.pipe(
		v.string(),
		v.transform(Number),
		v.integer(),
		v.minValue(0),
		v.maxValue(MAX_DEBUG_SLEEP_MS),
	),
});
export type SleepQuery = v.InferOutput<typeof SleepQuery>;
