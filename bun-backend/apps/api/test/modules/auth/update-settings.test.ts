import { describe, expect, test } from 'bun:test';
import { updateSettings } from '#src/modules/auth/use-cases/update-settings.ts';
import { getMe } from '#src/modules/auth/use-cases/get-me.ts';
import { inRollback, insertUser, live, viewOf } from './support.ts';

const maybe = live ? describe : describe.skip;

const signal = () => AbortSignal.timeout(5000);

maybe('updateSettings', () => {
	test('persists a change, keeps the rest, and creates the row for a user without one', async () => {
		await inRollback(async (deps, tx) => {
			const id = await insertUser(tx);
			const result = await updateSettings(
				deps,
				{ userId: id, patch: { timezone: 'Europe/Berlin' } },
				signal(),
			);
			expect(result).toEqual({
				ok: true,
				value: { timezone: 'Europe/Berlin', emailReminders: true, llmEnabled: true },
			});
			const me = await getMe(deps, viewOf(id), signal());
			expect(me.ok && me.value.settings.timezone).toBe('Europe/Berlin');
		});
	});

	test('another user sees their own defaults, not the change', async () => {
		await inRollback(async (deps, tx) => {
			const a = await insertUser(tx);
			const b = await insertUser(tx);
			await updateSettings(deps, { userId: a, patch: { llmEnabled: false } }, signal());
			const other = await getMe(deps, viewOf(b), signal());
			expect(other.ok && other.value.settings.llmEnabled).toBe(true);
		});
	});
});
