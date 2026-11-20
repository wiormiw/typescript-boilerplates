import { silentLogger, type Logger } from '@starter/lib/log';
import { BunSqlDatabase, type DatabaseOptions } from '@starter/db';

// The tests create and drop tables, so they run as the owner. `.env` names DATABASE_URL as the
// non-owner login role, which is why the owner URL is not read from it.
export const ownerUrl =
	Bun.env['DATABASE_MIGRATION_URL'] ?? 'postgres://postgres:starter@127.0.0.1:4632/starter';
export const appUrl =
	Bun.env['DATABASE_URL'] ?? 'postgres://starter_api:starter_api@127.0.0.1:4632/starter';

export const testOptions = (
	overrides: Partial<DatabaseOptions> & { logger?: Logger } = {},
): DatabaseOptions => ({
	url: ownerUrl,
	poolMax: 2,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	closeTimeoutS: 2,
	maxLifetimeS: 1800,
	checkTimeoutMs: 1000,
	slowQueryMs: 10_000,
	logger: silentLogger(),
	...overrides,
});

/** Whether anything answers at the test URL; integration tests skip when nothing does. */
export async function isReachable(): Promise<boolean> {
	const probe = new BunSqlDatabase(testOptions());
	try {
		await probe.start(AbortSignal.timeout(5000));
		return true;
	} catch {
		return false;
	} finally {
		await probe[Symbol.asyncDispose]();
	}
}
