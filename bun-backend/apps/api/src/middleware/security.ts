import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { PayloadTooLarge } from '@starter/lib/errors';
import { problemResponse } from '#src/shared/http/problem.ts';
import type { AppEnv } from '#src/shared/http/types.ts';

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
	c.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
	c.header('x-content-type-options', 'nosniff');
	c.header('referrer-policy', 'no-referrer');
	await next();
});

/**
 * Counted as the body streams in, so a chunked body is cut off too. Over `maxBytes` the answer is a
 * 413 problem with the request id, unlike Bun's bare 413 at the server's own ceiling (the same
 * `MAX_REQUEST_BODY_BYTES`, so this one is the one a client meets).
 */
export const bodyCeiling = (maxBytes: number) =>
	bodyLimit({
		maxSize: maxBytes,
		onError: (c) =>
			problemResponse(c, new PayloadTooLarge(`Request body exceeds ${maxBytes} bytes.`)),
	});
