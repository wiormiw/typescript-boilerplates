import { boolean, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { at, createdAt, updatedAt } from './columns.ts';

// better-auth's core tables, written by hand because the adapter is given these objects. They
// carry no policy: better-auth reads them outside `asUser` and filters by user itself.

export const user = pgTable('user', {
	id: uuid('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: boolean('email_verified').notNull().default(false),
	image: text('image'),
	createdAt: createdAt(),
	updatedAt: updatedAt(),
});

/** `user_id`, gone with its user (the cascade empties owned tables on account deletion). */
export const userRef = () => uuid('user_id').references(() => user.id, { onDelete: 'cascade' });

export const session = pgTable(
	'session',
	{
		id: uuid('id').primaryKey(),
		expiresAt: at('expires_at').notNull(),
		token: text('token').notNull().unique(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
		ipAddress: text('ip_address'),
		userAgent: text('user_agent'),
		userId: userRef().notNull(),
	},
	(t) => [index('session_user_id_idx').on(t.userId)],
);

export const account = pgTable(
	'account',
	{
		id: uuid('id').primaryKey(),
		accountId: text('account_id').notNull(),
		providerId: text('provider_id').notNull(),
		userId: userRef().notNull(),
		accessToken: text('access_token'),
		refreshToken: text('refresh_token'),
		idToken: text('id_token'),
		accessTokenExpiresAt: at('access_token_expires_at'),
		refreshTokenExpiresAt: at('refresh_token_expires_at'),
		scope: text('scope'),
		password: text('password'),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [index('account_user_id_idx').on(t.userId)],
);

export const verification = pgTable(
	'verification',
	{
		id: uuid('id').primaryKey(),
		identifier: text('identifier').notNull(),
		value: text('value').notNull(),
		expiresAt: at('expires_at').notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [index('verification_identifier_idx').on(t.identifier)],
);
