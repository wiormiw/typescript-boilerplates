import { boolean, pgTable, text } from 'drizzle-orm/pg-core';
import { userRef } from './auth.ts';
import { updatedAt } from './columns.ts';
import { ownerPolicy } from './rls.ts';

export const userSettings = pgTable.withRLS(
	'user_settings',
	{
		userId: userRef().primaryKey(),
		timezone: text('timezone').notNull().default('Asia/Jakarta'),
		emailReminders: boolean('email_reminders').notNull().default(true),
		llmEnabled: boolean('llm_enabled').notNull().default(true),
		updatedAt: updatedAt(),
	},
	() => [ownerPolicy('user_settings')],
);
