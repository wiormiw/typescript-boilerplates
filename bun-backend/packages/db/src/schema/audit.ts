import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { at } from './columns.ts';
import { ownerPolicy } from './rls.ts';

export const AUDIT_ACTIONS = [
	'sign_in',
	'sign_out_everywhere',
	'oauth_linked',
	'account_deleted',
] as const;

// No foreign key to user: the account_deleted row has to outlive the user it records.
export const audit = pgTable.withRLS(
	'audit',
	{
		id: uuid('id').primaryKey(),
		userId: uuid('user_id').notNull(),
		action: text('action', { enum: AUDIT_ACTIONS }).notNull(),
		at: at('at').notNull().defaultNow(),
		ip: text('ip'),
		userAgent: text('user_agent'),
	},
	(t) => [index('audit_user_id_at_idx').on(t.userId, t.at), ownerPolicy('audit')],
);
