import { Hono, type Context } from 'hono';
import {
	DeleteAccountBody,
	MeView,
	NativeExchangeBody,
	NativeFinishQuery,
	NativeStartQuery,
	SessionTokenView,
	SettingsView,
	UpdateSettingsBody,
} from '@starter/contracts';
import { untilAborted } from '@starter/lib/abort';
import { signedIn } from '#src/middleware/session.ts';
import { jsonBody, queryParams } from '#src/middleware/validate.ts';
import type { AuthModuleDeps, BrowserRedirect } from '#src/modules/auth/auth.types.ts';
import { deleteAccount } from '#src/modules/auth/use-cases/delete-account.ts';
import { exchangeNativeCode } from '#src/modules/auth/use-cases/exchange-native-code.ts';
import { finishGoogleSignIn } from '#src/modules/auth/use-cases/finish-google-sign-in.ts';
import { getMe } from '#src/modules/auth/use-cases/get-me.ts';
import { startGoogleSignIn } from '#src/modules/auth/use-cases/start-google-sign-in.ts';
import { signOutEverywhere } from '#src/modules/auth/use-cases/sign-out-everywhere.ts';
import { responseProblem } from '#src/modules/auth/use-cases/translate-auth-error.ts';
import { updateSettings } from '#src/modules/auth/use-cases/update-settings.ts';
import { problemResponse } from '#src/shared/http/problem.ts';
import { withClientAddress } from '#src/shared/http/client-address.ts';
import { noContent, passThrough, respond } from '#src/shared/http/reply.ts';
import { requireUser } from '#src/shared/http/session.ts';
import type { AppEnv } from '#src/shared/http/types.ts';

// The native routes carry a PKCE challenge or verifier, a one-time code or a flow id: a failing
// field is named, never quoted.
const SECRET = { redact: true };

/**
 * Sends the browser on with its cookies. Never cached, and no Referer: the location of a finish
 * carries the one-time code.
 */
function toBrowser(c: Context<AppEnv>, redirect: BrowserRedirect): Response {
	for (const cookie of redirect.cookies) c.header('set-cookie', cookie, { append: true });
	c.header('cache-control', 'no-store');
	c.header('referrer-policy', 'no-referrer');
	return c.redirect(redirect.location, 302);
}

/**
 * `/me` is ours; better-auth's routes sit behind `/auth/*` with its error answers rewritten as
 * problem+json. The catch-all is last: routes of ours under `/auth/` (the native ones) must be
 * registered before it, or it answers them.
 */
export function authRouter(deps: AuthModuleDeps) {
	const useCaseDeps = { database: deps.database, logger: deps.logger };
	const apiDeps = { ...useCaseDeps, auth: deps.auth };
	const nativeDeps = {
		auth: deps.auth,
		authCodes: deps.authCodes,
		redirectUris: deps.redirectUris,
		flowTtlS: deps.flowTtlS,
		codeTtlS: deps.codeTtlS,
	};
	return new Hono<AppEnv>()
		.get('/me', async (c) => {
			const { user } = requireUser(c);
			return respond(c, await getMe(useCaseDeps, user, c.var.signal), MeView);
		})
		.patch('/me/settings', signedIn, jsonBody(UpdateSettingsBody), async (c) => {
			const { user } = requireUser(c);
			const patch = c.req.valid('json');
			return respond(
				c,
				await updateSettings(useCaseDeps, { userId: user.id, patch }, c.var.signal),
				SettingsView,
			);
		})
		.delete('/me/sessions', async (c) => {
			const { user } = requireUser(c);
			const result = await signOutEverywhere(
				apiDeps,
				{ userId: user.id, headers: c.req.raw.headers },
				c.var.signal,
			);
			return result.ok ? noContent(c) : problemResponse(c, result.error);
		})
		.delete('/me', signedIn, jsonBody(DeleteAccountBody), async (c) => {
			const { user } = requireUser(c);
			const { password } = c.req.valid('json');
			const result = await deleteAccount(
				apiDeps,
				{ userId: user.id, headers: c.req.raw.headers, password },
				c.var.signal,
			);
			return result.ok ? noContent(c) : problemResponse(c, result.error);
		})
		.get('/auth/native/google/start', queryParams(NativeStartQuery, SECRET), async (c) => {
			const result = await startGoogleSignIn(nativeDeps, c.req.valid('query'), c.var.signal);
			// The state cookie must reach the browser or better-auth refuses the callback.
			return result.ok ? toBrowser(c, result.value) : problemResponse(c, result.error);
		})
		.get('/auth/native/google/finish', queryParams(NativeFinishQuery, SECRET), async (c) => {
			const result = await finishGoogleSignIn(
				nativeDeps,
				{ ...c.req.valid('query'), headers: c.req.raw.headers },
				c.var.signal,
			);
			return result.ok ? toBrowser(c, result.value) : problemResponse(c, result.error);
		})
		.post('/auth/native/exchange', jsonBody(NativeExchangeBody, SECRET), async (c) => {
			c.header('cache-control', 'no-store');
			return respond(
				c,
				await exchangeNativeCode(nativeDeps, c.req.valid('json'), c.var.signal),
				SessionTokenView,
			);
		})
		.all('/auth/*', async (c) => {
			const response = await untilAborted(deps.auth.handler(withClientAddress(c)), c.var.signal);
			// Redirects and successes go out as they are; only a failure is ours to reword.
			if (response.status < 400) return passThrough(c, response);
			const problem = await responseProblem(response);
			// A 4xx is the API working; a 5xx is better-auth failing (the database, a hook), and nothing
			// threw for the error handler to log. The reason code only: never the body.
			if (response.status >= 500) {
				c.var.logger.error(
					{ status: response.status, reason: problem.details?.['reason'], path: c.req.path },
					'better-auth failed',
				);
			}
			// better-auth's limiter says when to retry in X-Retry-After; clients read Retry-After.
			const retryAfter =
				response.headers.get('retry-after') ?? response.headers.get('x-retry-after');
			if (retryAfter) c.header('retry-after', retryAfter);
			return problemResponse(c, problem);
		});
}
