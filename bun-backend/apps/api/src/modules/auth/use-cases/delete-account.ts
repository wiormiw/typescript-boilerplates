import { asUser } from '@starter/db';
import { ValidationFailed, type AppError } from '@starter/lib/errors';
import { err, ok, type Result } from '@starter/lib/result';
import type { AuthApiDeps, DeleteAccountInput } from '#src/modules/auth/auth.types.ts';
import { hasPasswordLogin } from '#src/modules/auth/repository/auth.repository.ts';
import { callAuthApi } from '#src/modules/auth/use-cases/translate-auth-error.ts';

/**
 * Deletes the account through better-auth, which checks the password; its `beforeDelete` hook
 * rewrites the audit trail and the foreign keys cascade the rest.
 */
export async function deleteAccount(
	deps: AuthApiDeps,
	input: DeleteAccountInput,
	signal: AbortSignal,
): Promise<Result<void, AppError>> {
	const { userId, headers, password } = input;
	// better-auth only checks that the session is fresh when no password comes with the request, so
	// a stolen fresh token could delete a password account. Ask for the password ourselves.
	if (password === undefined) {
		const protectedByPassword = await asUser(
			deps.database,
			{ userId, signal, operation: 'auth.delete_account.lookup', logger: deps.logger },
			async (tx) => ok(await hasPasswordLogin(tx, userId)),
		);
		if (protectedByPassword.ok && protectedByPassword.value) {
			return err(
				new ValidationFailed('Enter your password to delete the account.', {
					details: { reason: 'PASSWORD_REQUIRED' },
				}),
			);
		}
	}
	const deleted = await callAuthApi(
		deps.auth.api.deleteUser({ body: password === undefined ? {} : { password }, headers }),
		signal,
	);
	return deleted.ok ? ok(undefined) : deleted;
}
