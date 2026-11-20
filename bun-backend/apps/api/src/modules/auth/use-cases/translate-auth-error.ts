import { APIError } from 'better-auth/api';
import * as v from 'valibot';
import { BetterAuthFailure } from '@starter/contracts';
import { untilAborted } from '@starter/lib/abort';
import {
	Forbidden,
	RateLimited,
	RouteNotFound,
	Unauthenticated,
	UnexpectedError,
	ValidationFailed,
	type AppError,
} from '@starter/lib/errors';
import { err, ok, type Result } from '@starter/lib/result';

/**
 * better-auth's failure as ours: its `code` rides along as `details.reason` (a stable, client-safe
 * identifier), its message only where it is the user's to read. A body better-auth did not shape
 * as it says counts as saying nothing. Every way better-auth fails comes through here, so the wire
 * has one error format.
 */
export function authProblem(status: number, body: unknown): AppError {
	const parsed = v.safeParse(BetterAuthFailure, body);
	const { code, message } = parsed.success ? parsed.output : {};
	const text = message === '' ? undefined : message;
	const options = code === undefined ? undefined : { details: { reason: code } };
	switch (status) {
		case 400:
		case 422:
			return new ValidationFailed(text, options);
		case 401:
			return new Unauthenticated(undefined, options);
		case 403:
			return new Forbidden(undefined, options);
		case 404:
			return new RouteNotFound(undefined, options);
		case 429:
			return new RateLimited(undefined, options);
		default:
			return new UnexpectedError(undefined, options);
	}
}

/** The problem for a non-2xx answer from better-auth's handler. */
export async function responseProblem(response: Response): Promise<AppError> {
	let body: unknown;
	if (response.headers.get('content-type')?.includes('json')) {
		body = await response.json().catch(() => undefined);
	}
	return authProblem(response.status, body);
}

/**
 * Awaits a call into `auth.api.*` (which takes no signal) under `signal`. What better-auth throws
 * as an `APIError` comes back as the problem it means; anything else is a bug and stays thrown.
 */
export async function callAuthApi<T>(
	work: Promise<T>,
	signal: AbortSignal,
): Promise<Result<T, AppError>> {
	try {
		return ok(await untilAborted(work, signal));
	} catch (error) {
		if (error instanceof APIError) return err(authProblem(error.statusCode, error.body));
		throw error;
	}
}
