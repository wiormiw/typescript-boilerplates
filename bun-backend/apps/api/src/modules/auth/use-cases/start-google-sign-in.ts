import * as v from 'valibot';
import { BetterAuthSocialRedirect, type NativeStartQuery } from '@starter/contracts';
import {
	ProviderNotConfigured,
	RedirectNotAllowed,
	RouteNotFound,
	UnexpectedError,
	type AppError,
} from '@starter/lib/errors';
import { err, ok, type Result } from '@starter/lib/result';
import type { BrowserRedirect, NativeDeps } from '#src/modules/auth/auth.types.ts';
import { callAuthApi, responseProblem } from '#src/modules/auth/use-cases/translate-auth-error.ts';

/**
 * Opens a native sign-in: the redirect must be on the allowlist (checked before anything is
 * stored or sent), the flow is parked in Valkey under a fresh id, and better-auth supplies the
 * Google URL and its state cookie. Only the id travels, inside better-auth's callbackURL.
 */
export async function startGoogleSignIn(
	deps: NativeDeps,
	query: NativeStartQuery,
	signal: AbortSignal,
): Promise<Result<BrowserRedirect, AppError>> {
	if (!deps.redirectUris.includes(query.redirect_uri)) return err(new RedirectNotAllowed());
	const id = Bun.randomUUIDv7();
	const answered = await callAuthApi(
		deps.auth.api.signInSocial({
			body: {
				provider: 'google',
				callbackURL: `/auth/native/google/finish?flow=${id}`,
				disableRedirect: true,
			},
			asResponse: true,
		}),
		signal,
	);
	// better-auth answers an unconfigured provider with a 404, thrown or returned.
	if (!answered.ok) {
		return err(
			answered.error instanceof RouteNotFound ? new ProviderNotConfigured() : answered.error,
		);
	}
	const response = answered.value;
	if (response.status === 404) return err(new ProviderNotConfigured());
	if (!response.ok) return err(await responseProblem(response));
	const redirect = v.safeParse(BetterAuthSocialRedirect, await response.json());
	if (!redirect.success) return err(new UnexpectedError('better-auth gave no provider URL'));
	const url = redirect.output.url;
	await deps.authCodes.putFlow(
		id,
		{
			codeChallenge: query.code_challenge,
			redirectUri: query.redirect_uri,
			clientState: query.state,
		},
		deps.flowTtlS,
		signal,
	);
	return ok({ location: url, cookies: response.headers.getSetCookie() });
}
