import type { UserView } from '@starter/contracts';
import { schema, type Tx } from '@starter/db';
import { withRollback } from '@starter/db/testing';
import { silentLogger } from '@starter/lib/log';
import type { AuthModuleDeps } from '#src/modules/auth/auth.types.ts';
import {
	appDatabaseUrl,
	isMigrated,
	isPostgresReachable,
	openDatabase,
	ownerDatabaseUrl,
} from '../../support/infra.ts';

export const live = (await isPostgresReachable()) && (await isMigrated(ownerDatabaseUrl));

/** The API's own role, so row-level security applies as in production. */
export const database = openDatabase(appDatabaseUrl, 2);

/** A user row, which better-auth owns and the app role may write; no settings row. */
export async function insertUser(tx: Tx): Promise<string> {
	const id = Bun.randomUUIDv7();
	await tx.insert(schema.user).values({ id, name: 'T', email: `${id}@example.test` });
	return id;
}

/** Runs `work` on a rolled-back transaction, with the deps a use case takes over it. */
export function inRollback(
	work: (deps: Pick<AuthModuleDeps, 'database' | 'logger'>, tx: Tx) => Promise<void>,
): Promise<void> {
	return withRollback(database.db, (tx) =>
		work({ database: { db: tx, control: database.control }, logger: silentLogger() }, tx),
	);
}

/** The session user a router or use case sees for `id`, as `insertUser` made it. */
export const viewOf = (id: string): UserView => ({
	id,
	email: `${id}@example.test`,
	name: 'T',
	emailVerified: true,
});
