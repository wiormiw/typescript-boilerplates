import * as v from 'valibot';

/** RFC 9457 problem details, matching what @starter/lib/problem renders. */
export const ProblemView = v.object({
	type: v.string(),
	title: v.string(),
	status: v.number(),
	detail: v.string(),
	code: v.string(),
	details: v.optional(v.record(v.string(), v.unknown())),
	requestId: v.string(),
	// Present only when the request was traced.
	traceId: v.optional(v.string()),
});
export type ProblemView = v.InferOutput<typeof ProblemView>;
