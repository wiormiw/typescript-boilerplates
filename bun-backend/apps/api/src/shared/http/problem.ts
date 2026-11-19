import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { RequestTimeout, type AppError } from '@starter/lib/errors';
import { PROBLEM_CONTENT_TYPE, toProblem } from '@starter/lib/problem';
import type { AppEnv } from '#src/shared/http/types.ts';

/** The problem+json response for a failure: how the error handler and `respond` render it. */
export function problemResponse<E extends AppEnv>(c: Context<E>, failure: AppError): Response {
	const { body, status } = toProblem(failure, {
		requestId: c.get('requestId') ?? '',
		traceId: c.get('traceId'),
	});
	// Our own deadline passing is a gateway timeout, not the 502 an upstream's failure gets.
	const timedOut = failure instanceof RequestTimeout;
	const rendered = timedOut ? { ...body, status: 504, title: 'Request timed out' } : body;
	// newResponse, not `new Response`, so headers set earlier (request id, Retry-After) ride along.
	return c.newResponse(
		JSON.stringify(rendered),
		(timedOut ? 504 : status) as ContentfulStatusCode,
		{ 'content-type': PROBLEM_CONTENT_TYPE },
	);
}
