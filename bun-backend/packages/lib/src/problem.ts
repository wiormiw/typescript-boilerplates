import type { ProblemView } from '@starter/contracts';
import type { AppError, ErrorKind } from './errors.ts';

export interface ProblemIds {
	requestId: string;
	traceId?: string | undefined;
}

export interface ProblemResult {
	body: ProblemView;
	status: number;
}

/** The only place an error kind becomes an HTTP status. */
export const httpStatusByKind: Record<ErrorKind, number> = {
	validation: 400,
	unprocessable: 422,
	unauthorized: 401,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	payload_too_large: 413,
	rate_limited: 429,
	// A dependency being down isn't our bug; 502 keeps it out of the 500 alerts.
	external: 502,
	// Shutting down, not failing: the client retries after Retry-After.
	unavailable: 503,
	internal: 500,
};

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

const TYPE_BASE = 'urn:starter:problem:';

const titleByKind: Record<ErrorKind, string> = {
	validation: 'Validation failed',
	unprocessable: 'Unprocessable',
	unauthorized: 'Authentication required',
	forbidden: 'Forbidden',
	not_found: 'Not found',
	conflict: 'Conflict',
	payload_too_large: 'Payload too large',
	rate_limited: 'Too many requests',
	external: 'Upstream service failed',
	unavailable: 'Service unavailable',
	internal: 'Unexpected error',
};

export function toProblem(error: AppError, ids: ProblemIds): ProblemResult {
	const status = httpStatusByKind[error.kind];
	return {
		status,
		body: {
			type: `${TYPE_BASE}${error.code}`,
			title: titleByKind[error.kind],
			status,
			// An internal message can carry connection strings or row data; the request id finds it.
			detail:
				error.kind === 'internal'
					? 'An unexpected error occurred. The request id identifies this request in the logs.'
					: error.message,
			code: error.code,
			...(error.details ? { details: error.details } : {}),
			requestId: ids.requestId,
			...(ids.traceId ? { traceId: ids.traceId } : {}),
		},
	};
}
