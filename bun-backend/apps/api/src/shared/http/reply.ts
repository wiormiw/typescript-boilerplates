import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import * as v from 'valibot';
import type { AppError } from '@starter/lib/errors';
import type { Result } from '@starter/lib/result';
import type { AppEnv } from '#src/shared/http/types.ts';
import { problemResponse } from '#src/shared/http/problem.ts';

/**
 * Sends `value` as `view` describes it. Parsing drops keys the view doesn't declare, so a column
 * added to a query never reaches the wire; a value the view rejects throws, and is our bug.
 */
export function reply<S extends v.GenericSchema, E extends AppEnv = AppEnv>(
	c: Context<E>,
	view: S,
	value: v.InferInput<S>,
	status: ContentfulStatusCode = 200,
): Response {
	return c.json(v.parse(view, value) as object, status);
}

/**
 * A service's Result as the answer: the value through `view`, or the problem a throw would be.
 * Generic over the whole result, so what `isError` leaves behind is accepted. The result type
 * comes last, so `respond<typeof View, Env>` binds as `reply<typeof View, Env>` does.
 */
export function respond<
	S extends v.GenericSchema,
	E extends AppEnv = AppEnv,
	R extends Result<v.InferInput<S>, AppError> = Result<v.InferInput<S>, AppError>,
>(c: Context<E>, result: R, view: S, status: ContentfulStatusCode = 200): Response {
	return result.ok ? reply(c, view, result.value, status) : problemResponse(c, result.error);
}

/** An empty 204 that keeps what `c.header` set (request id, security headers). */
export function noContent<E extends AppEnv>(c: Context<E>): Response {
	return c.newResponse(null, 204);
}

/**
 * Re-sends a foreign Response (better-auth's) through `c.newResponse`, so the headers set on `c`
 * join its own. A plain `new Response` would drop them (trap 5); `set-cookie` is appended one by
 * one because a Headers object folds repeats into a single value otherwise.
 */
export function passThrough<E extends AppEnv>(c: Context<E>, response: Response): Response {
	const isBodyLess = response.status === 204 || response.status === 205 || response.status === 304;
	const out = isBodyLess
		? c.newResponse(null, response.status)
		: c.newResponse(response.body, response.status as ContentfulStatusCode);
	for (const [name, value] of response.headers) {
		if (name !== 'set-cookie') out.headers.set(name, value);
	}
	for (const cookie of response.headers.getSetCookie()) out.headers.append('set-cookie', cookie);
	return out;
}
