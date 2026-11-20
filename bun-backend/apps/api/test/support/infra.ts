import { SQL } from 'bun';
import { BunSqlDatabase } from '@starter/db';
import { silentLogger } from '@starter/lib/log';
import { Valkey } from '#src/infra/valkey.ts';
import { defaults } from './env.ts';

export const valkeyUrl = Bun.env['VALKEY_URL'] ?? 'redis://127.0.0.1:4679';

export const openValkey = (url = valkeyUrl) =>
	new Valkey({
		url,
		connectTimeoutMs: 1000,
		checkTimeoutMs: defaults.HEALTH_CHECK_TIMEOUT_MS,
		logger: silentLogger(),
	});

/** Whether anything answers at the test URL; integration tests skip when nothing does. */
export async function isValkeyReachable(): Promise<boolean> {
	const probe = openValkey();
	try {
		await probe.start(AbortSignal.timeout(1500));
		return true;
	} catch {
		return false;
	} finally {
		await probe[Symbol.asyncDispose]();
	}
}

// `.env` names DATABASE_URL as the non-owner login role, so the owner has its own variable.
export const ownerDatabaseUrl =
	Bun.env['DATABASE_MIGRATION_URL'] ?? 'postgres://postgres:starter@127.0.0.1:4632/starter';
export const appDatabaseUrl =
	Bun.env['DATABASE_URL'] ?? 'postgres://starter_api:starter_api@127.0.0.1:4632/starter';

/** A pool on `url` sized for tests; the caller disposes it. Defaults to the API's own role. */
export const openDatabase = (url = appDatabaseUrl, poolMax = 4) =>
	new BunSqlDatabase({
		url,
		poolMax,
		idleTimeoutS: 5,
		connectTimeoutS: 2,
		closeTimeoutS: 2,
		maxLifetimeS: defaults.DB_MAX_LIFETIME_S,
		checkTimeoutMs: defaults.HEALTH_CHECK_TIMEOUT_MS,
		slowQueryMs: 10_000,
		logger: silentLogger(),
	});

/** Whether Postgres answers at the test URL; integration tests skip when it does not. */
export async function isPostgresReachable(): Promise<boolean> {
	const probe = openDatabase(ownerDatabaseUrl, 1);
	try {
		await probe.start(AbortSignal.timeout(3000));
		return true;
	} catch {
		return false;
	} finally {
		await probe[Symbol.asyncDispose]();
	}
}

/** Whether `url`'s database has been migrated; tests that need tables skip when it has not. */
export async function isMigrated(url: string): Promise<boolean> {
	const sql = new SQL({ url, max: 1, connectionTimeout: 2 });
	try {
		const rows = await sql`select to_regclass('drizzle.__drizzle_migrations') as t`;
		return rows[0]?.t != null;
	} catch {
		return false;
	} finally {
		await sql.close();
	}
}
