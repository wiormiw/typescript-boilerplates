import { and, eq } from 'drizzle-orm';
import { schema, userSettings, type Tx } from '@starter/db';
import type { SettingsView, UpdateSettingsBody } from '@starter/contracts';

const columns = {
	timezone: userSettings.timezone,
	emailReminders: userSettings.emailReminders,
	llmEnabled: userSettings.llmEnabled,
};

/**
 * Makes sure the user has a settings row. `user.create.after` can fail once the user exists, so
 * the row cannot be assumed; the defaults are the column defaults.
 */
export async function ensureSettings(tx: Tx, userId: string): Promise<void> {
	await tx.insert(userSettings).values({ userId }).onConflictDoNothing();
}

export async function readSettings(tx: Tx, userId: string): Promise<SettingsView> {
	const [row] = await tx.select(columns).from(userSettings).where(eq(userSettings.userId, userId));
	if (!row) throw new Error('settings row missing after ensureSettings');
	return row;
}

export async function updateSettingsRow(
	tx: Tx,
	userId: string,
	patch: UpdateSettingsBody,
): Promise<SettingsView> {
	const [row] = await tx
		.update(userSettings)
		.set({ ...patch, updatedAt: new Date() })
		.where(eq(userSettings.userId, userId))
		.returning(columns);
	if (!row) throw new Error('settings row missing after ensureSettings');
	return row;
}

/**
 * Whether the user signs in with a password. better-auth keeps it on an `account` row whose
 * provider is 'credential'; that table has no policy, so the filter by user id is the only scope.
 */
export async function hasPasswordLogin(tx: Tx, userId: string): Promise<boolean> {
	const rows = await tx
		.select({ id: schema.account.id })
		.from(schema.account)
		.where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, 'credential')))
		.limit(1);
	return rows.length > 0;
}
