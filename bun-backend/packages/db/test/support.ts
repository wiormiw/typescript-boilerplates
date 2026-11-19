import { silentLogger, type Logger } from '@starter/lib/log';
import { BunSqlDatabase, type DatabaseOptions } from '@starter/db';

export const url = Bun.env['DATABASE_URL'] ?? 'postgres://postgres:starter@127.0.0.1:4632/starter';

export const testOptions = (
	overrides: Partial<DatabaseOptions> & { logger?: Logger } = {},
): DatabaseOptions => ({
	url,
	poolMax: 2,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	closeTimeoutS: 2,
	slowQueryMs: 10_000,
	logger: silentLogger(),
	...overrides,
});

/** Whether anything answers at the test URL; integration tests skip when nothing does. */
export async function isReachable(): Promise<boolean> {
	const probe = BunSqlDatabase.create(testOptions());
	try {
		await probe.start(AbortSignal.timeout(5000));
		return true;
	} catch {
		return false;
	} finally {
		await probe[Symbol.asyncDispose]();
	}
}
