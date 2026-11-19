import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { PayloadTooLarge } from '@starter/lib/errors';
import { problemResponse } from '#src/shared/http/problem.ts';
import type { AppEnv } from '#src/shared/http/types.ts';

const MAX_BODY_BYTES = 1024 * 1024;

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
	c.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
	c.header('x-content-type-options', 'nosniff');
	c.header('referrer-policy', 'no-referrer');
	await next();
});

// Counted as the body streams in, so a chunked body is cut off too. Over it, the answer is a 413
// problem with the request id, unlike Bun's bare 413 at the server's own ceiling.
export const bodyCeiling = bodyLimit({
	maxSize: MAX_BODY_BYTES,
	onError: (c) =>
		problemResponse(c, new PayloadTooLarge(`Request body exceeds ${MAX_BODY_BYTES} bytes.`)),
});
