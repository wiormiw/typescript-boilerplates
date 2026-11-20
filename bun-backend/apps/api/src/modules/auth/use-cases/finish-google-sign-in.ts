import { getCookies } from 'better-auth/cookies';
import { untilAborted } from '@starter/lib/abort';
import {
	RedirectNotAllowed,
	SignInFlowExpired,
	Unauthenticated,
	type AppError,
} from '@starter/lib/errors';
import { err, ok, type Result } from '@starter/lib/result';
import type {
	BrowserRedirect,
	FinishGoogleSignInInput,
	NativeDeps,
} from '#src/modules/auth/auth.types.ts';

/** The value of cookie `wanted` as the browser sent it. */
function cookieValue(headers: Headers, wanted: string): string | undefined {
	for (const part of (headers.get('cookie') ?? '').split(';')) {
		const at = part.indexOf('=');
		if (at < 0 || part.slice(0, at).trim() !== wanted) continue;
		try {
			return decodeURIComponent(part.slice(at + 1).trim());
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * The browser is back from Google with better-auth's session cookie. The flow is taken (single
 * use), a code is stored for the native client, and the browser is sent to its redirect with it.
 * The session itself stays: it is the one the client will receive.
 *
 * A browser that comes back without a session keeps the flow (a link prefetch must not burn it);
 * one that comes back with Google's `error` (consent denied) ends it, and gets no code even if it
 * holds some older session.
 */
export async function finishGoogleSignIn(
	deps: NativeDeps,
	input: FinishGoogleSignInInput,
	signal: AbortSignal,
): Promise<Result<BrowserRedirect, AppError>> {
	if (input.error !== undefined) {
		await deps.authCodes.takeFlow(input.flow, signal);
		return err(new Unauthenticated(undefined, { details: { reason: input.error } }));
	}
	// The name better-auth gives the cookie, `__Secure-` prefix included when served over https.
	const { name, attributes } = getCookies(deps.auth.options).sessionToken;
	const token = cookieValue(input.headers, name);
	if (!token) return err(new Unauthenticated());
	const session = await untilAborted(deps.auth.api.getSession({ headers: input.headers }), signal);
	if (!session) return err(new Unauthenticated());
	const flow = await deps.authCodes.takeFlow(input.flow, signal);
	if (!flow) return err(new SignInFlowExpired());
	// Stored by `start` after the same check; repeated in case the allowlist has since shrunk.
	if (!deps.redirectUris.includes(flow.redirectUri)) return err(new RedirectNotAllowed());
	const code = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
	await deps.authCodes.putCode(
		code,
		{ sessionToken: token, codeChallenge: flow.codeChallenge, userId: session.user.id },
		deps.codeTtlS,
		signal,
	);
	const location = new URL(flow.redirectUri);
	location.searchParams.set('code', code);
	location.searchParams.set('state', flow.clientState);
	const secure = attributes.secure ? '; Secure' : '';
	return ok({
		location: location.toString(),
		// Drops the browser's copy only: the session lives on in the native client.
		cookies: [`${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`],
	});
}
