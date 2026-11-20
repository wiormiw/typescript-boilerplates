import { validator } from 'hono/validator';
import * as v from 'valibot';
import { ValidationFailed } from '@starter/lib/errors';

interface ValidateOptions {
	/**
	 * Name a failing field but never quote its message. Valibot's messages can echo the value they
	 * rejected, and some inputs (a PKCE verifier, a one-time code) must not come back in an error
	 * or reach a log.
	 */
	redact?: boolean;
}

/** `value` as `schema` reads it, or the 400 that says which fields failed. */
function checked<S extends v.GenericSchema>(
	schema: S,
	value: unknown,
	{ redact = false }: ValidateOptions,
): v.InferOutput<S> {
	const parsed = v.safeParse(schema, value);
	if (parsed.success) return parsed.output;
	const issues = parsed.issues.map((issue) => ({
		path: v.getDotPath(issue) ?? '',
		message: redact ? 'invalid' : issue.message,
	}));
	const title = redact ? undefined : parsed.issues[0]?.message;
	throw new ValidationFailed(title, { details: { issues } });
}

/**
 * The JSON body, checked against a contract; the route reads it with `c.req.valid('json')`.
 * Hono reads the body only when the content type is JSON, so a request with no body (or another
 * type) is checked as `{}`: a body whose fields are all optional may be left out. Malformed JSON
 * is Hono's 400, which the error handler answers as a validation problem.
 */
export const jsonBody = <S extends v.GenericSchema>(schema: S, options: ValidateOptions = {}) =>
	validator('json', (value) => checked(schema, value, options));

/** The query string, checked against a contract; the route reads it with `c.req.valid('query')`. */
export const queryParams = <S extends v.GenericSchema>(schema: S, options: ValidateOptions = {}) =>
	validator('query', (value) => checked(schema, value, options));
