import { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';
import { migrate } from 'drizzle-orm/bun-sql/migrator';
import { APP_ROLE } from './schema/rls.ts';
import type { MigrateOptions } from './types.ts';
export type { MigrateOptions } from './types.ts';

/**
 * Applies the migrations as the owner, then makes sure the login role named in `appUrl` exists,
 * belongs to `starter_app` and has the URL's password. Safe to run any number of times.
 */
export async function migrateDatabase(options: MigrateOptions): Promise<void> {
	const { ownerUrl, appUrl, migrationsFolder, connectTimeoutS, logger, signal } = options;
	const login = new URL(appUrl);
	const role = decodeURIComponent(login.username);
	const password = decodeURIComponent(login.password);
	if (!role || !password) throw new Error('the app database URL needs a user and a password');

	// One connection: DDL, and no pool to wind down.
	const sql = new SQL({ url: ownerUrl, max: 1, connectionTimeout: connectTimeoutS });
	try {
		signal.throwIfAborted();
		// Refuse before changing anything: a superuser ignores RLS, and demoting one (the owner, say)
		// would break the database rather than secure the API.
		const [existing] = await sql`select rolsuper from pg_roles where rolname = ${role}`;
		if (existing?.rolsuper) {
			throw new Error(
				`the app login role "${role}" is a superuser and would bypass row-level security`,
			);
		}
		const failed = await migrate(drizzle({ client: sql }), { migrationsFolder });
		if (failed) throw new Error(`migrations refused: ${failed.exitCode}`);
		logger.info('migrations applied');

		signal.throwIfAborted();
		// Postgres does the quoting: %I for names, %L for the password. `create role` takes no bind
		// parameters, so `format` builds the statement and it runs as text.
		const [text] = await sql`
			select
				format('create role %I login nosuperuser nobypassrls nocreaterole nocreatedb password %L', ${role}::text, ${password}::text) as create_role,
				format('alter role %I login nosuperuser nobypassrls nocreaterole nocreatedb password %L', ${role}::text, ${password}::text) as alter_role,
				format('grant %I to %I', ${APP_ROLE}::text, ${role}::text) as grant_group`;
		await sql.unsafe(existing ? text.alter_role : text.create_role);
		// A no-op for a role that is already a member.
		await sql.unsafe(text.grant_group);
		logger.info({ role }, 'app login role ready');
	} finally {
		await sql.close();
	}
}
