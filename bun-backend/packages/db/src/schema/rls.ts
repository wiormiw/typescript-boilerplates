import { sql } from 'drizzle-orm';
import { pgPolicy, pgRole } from 'drizzle-orm/pg-core';

/** The group every API login role belongs to; policies and grants name it, never a login. */
export const APP_ROLE = 'starter_app';
/** Created by the first migration, so Drizzle must only reference it. */
export const appRole = pgRole(APP_ROLE).existing();

// Trap 10: the setting resets to '' (not NULL) after a transaction, so '' must read as unset.
const OWNER = sql`user_id = nullif(current_setting('app.user_id', true), '')::uuid`;

/** One policy for every owned table: a row is visible and writable only to its `user_id`. */
export const ownerPolicy = (table: string) =>
	pgPolicy(`${table}_owner`, { for: 'all', to: appRole, using: OWNER, withCheck: OWNER });
