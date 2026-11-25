import { boolean, pgTable, text } from 'drizzle-orm/pg-core';
import { userRef } from './auth.ts';
import { updatedAt } from './columns.ts';
import { ownerPolicy } from './rls.ts';

/** What a user's timezone is until they set one. */
export const DEFAULT_TIMEZONE = 'Asia/Jakarta';

export const userSettings = pgTable.withRLS(
	'user_settings',
	{
		userId: userRef().primaryKey(),
		timezone: text('timezone').notNull().default(DEFAULT_TIMEZONE),
		emailReminders: boolean('email_reminders').notNull().default(true),
		llmEnabled: boolean('llm_enabled').notNull().default(true),
		updatedAt: updatedAt(),
	},
	() => [ownerPolicy('user_settings')],
);
