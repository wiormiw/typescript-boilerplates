import { asUser } from '@starter/db';
import type { SettingsView } from '@starter/contracts';
import type { AppError } from '@starter/lib/errors';
import { ok, type Result } from '@starter/lib/result';
import type { AuthUseCaseDeps, UpdateSettingsInput } from '#src/modules/auth/auth.types.ts';
import { ensureSettings, updateSettingsRow } from '#src/modules/auth/repository/auth.repository.ts';

export function updateSettings(
	deps: AuthUseCaseDeps,
	input: UpdateSettingsInput,
	signal: AbortSignal,
): Promise<Result<SettingsView, AppError>> {
	const { userId, patch } = input;
	return asUser(
		deps.database,
		{ userId, signal, operation: 'auth.update_settings', logger: deps.logger },
		async (tx) => {
			// A user whose sign-up hook failed has no row yet; the update would otherwise hit nothing.
			await ensureSettings(tx, userId);
			return ok(await updateSettingsRow(tx, userId, patch));
		},
	);
}
