import { asUser } from '@starter/db';
import type { MeView, UserView } from '@starter/contracts';
import { ok, type Result } from '@starter/lib/result';
import type { AppError } from '@starter/lib/errors';
import type { AuthUseCaseDeps } from '#src/modules/auth/auth.types.ts';
import { ensureSettings, readSettings } from '#src/modules/auth/repository/auth.repository.ts';

/** The user and their settings, creating the settings row if sign-up's hook never did. */
export function getMe(
	deps: AuthUseCaseDeps,
	user: UserView,
	signal: AbortSignal,
): Promise<Result<MeView, AppError>> {
	return asUser(
		deps.database,
		{ userId: user.id, signal, operation: 'auth.get_me', logger: deps.logger },
		async (tx) => {
			await ensureSettings(tx, user.id);
			return ok({ user, settings: await readSettings(tx, user.id) });
		},
	);
}
