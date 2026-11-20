import { describe, expect, test } from 'bun:test';
import { asUser, userSettings } from '@starter/db';
import { ok } from '@starter/lib/result';
import { eq } from 'drizzle-orm';
import { getMe } from '#src/modules/auth/use-cases/get-me.ts';
import { inRollback, insertUser, live, viewOf } from './support.ts';

const maybe = live ? describe : describe.skip;

maybe('getMe', () => {
	test('a user without a settings row gets the defaults, and the row then exists', async () => {
		await inRollback(async (deps, tx) => {
			const id = await insertUser(tx);
			const result = await getMe(deps, viewOf(id), AbortSignal.timeout(5000));
			expect(result).toEqual({
				ok: true,
				value: {
					user: viewOf(id),
					settings: { timezone: 'Asia/Jakarta', emailReminders: true, llmEnabled: true },
				},
			});
			const rows = await asUser(
				deps.database,
				{ userId: id, signal: AbortSignal.timeout(5000), operation: 'test.read' },
				async (inner) =>
					ok(await inner.select().from(userSettings).where(eq(userSettings.userId, id))),
			);
			expect(rows.ok && rows.value).toHaveLength(1);
		});
	});
});
