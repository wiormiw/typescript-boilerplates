import { asUser, recordAudit } from '@starter/db';
import type { AppError } from '@starter/lib/errors';
import { ok, type Result } from '@starter/lib/result';
import type { AuthApiDeps, CallerInput } from '#src/modules/auth/auth.types.ts';
import { callAuthApi } from '#src/modules/auth/use-cases/translate-auth-error.ts';

/** Revokes every session of the caller, then records it. */
export async function signOutEverywhere(
	deps: AuthApiDeps,
	input: CallerInput,
	signal: AbortSignal,
): Promise<Result<void, AppError>> {
	const { userId, headers } = input;
	const revoked = await callAuthApi(deps.auth.api.revokeSessions({ headers }), signal);
	if (!revoked.ok) return revoked;
	return asUser(
		deps.database,
		{ userId, signal, operation: 'auth.sign_out_everywhere', logger: deps.logger },
		async (tx) => {
			await recordAudit(tx, {
				userId,
				action: 'sign_out_everywhere',
				userAgent: headers.get('user-agent') ?? undefined,
			});
			return ok(undefined);
		},
	);
}
