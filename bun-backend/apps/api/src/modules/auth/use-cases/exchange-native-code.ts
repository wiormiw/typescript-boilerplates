import { timingSafeEqual } from 'node:crypto';
import * as v from 'valibot';
import { UserView, type NativeExchangeBody, type SessionTokenView } from '@starter/contracts';
import { untilAborted } from '@starter/lib/abort';
import { InvalidGrant, type AppError } from '@starter/lib/errors';
import { err, ok, type Result } from '@starter/lib/result';
import type { NativeDeps } from '#src/modules/auth/auth.types.ts';

/** RFC 7636 S256: base64url(sha256(verifier)). */
export function challengeOf(verifier: string): string {
	return new Bun.CryptoHasher('sha256').update(verifier).digest('base64url');
}

/**
 * Trades a one-time code and its PKCE verifier for the session token. The code is taken (deleted)
 * before the verifier is looked at, so a wrong guess burns it: a code gets one try. Every failure
 * is the same InvalidGrant, so nothing says which part was wrong.
 */
export async function exchangeNativeCode(
	deps: NativeDeps,
	body: NativeExchangeBody,
	signal: AbortSignal,
): Promise<Result<SessionTokenView, AppError>> {
	const grant = await deps.authCodes.takeCode(body.code, signal);
	if (!grant) return err(new InvalidGrant());
	const expected = Buffer.from(grant.codeChallenge);
	const actual = Buffer.from(challengeOf(body.code_verifier));
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
		return err(new InvalidGrant());
	}
	// The session may have ended since the code was made; the token is only worth giving if it lives.
	const session = await untilAborted(
		deps.auth.api.getSession({
			headers: new Headers({ authorization: `Bearer ${grant.sessionToken}` }),
		}),
		signal,
	);
	if (!session || session.user.id !== grant.userId) return err(new InvalidGrant());
	return ok({ token: grant.sessionToken, user: v.parse(UserView, session.user) });
}
