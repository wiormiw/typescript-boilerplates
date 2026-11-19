import { BunSqlDatabase } from '@starter/db';
import { silentLogger } from '@starter/lib/log';
import { Valkey } from '#src/infra/valkey.ts';

export const valkeyUrl = Bun.env['VALKEY_URL'] ?? 'redis://127.0.0.1:4679';

export const openValkey = (url = valkeyUrl) =>
	Valkey.create({ url, connectTimeoutMs: 1000, logger: silentLogger() });

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

export const databaseUrl =
	Bun.env['DATABASE_URL'] ?? 'postgres://postgres:starter@127.0.0.1:4632/starter';

/** Whether Postgres answers at the test URL; integration tests skip when it does not. */
export async function isPostgresReachable(): Promise<boolean> {
	const probe = BunSqlDatabase.create({
		url: databaseUrl,
		poolMax: 1,
		idleTimeoutS: 5,
		connectTimeoutS: 2,
		closeTimeoutS: 2,
		slowQueryMs: 10_000,
		logger: silentLogger(),
	});
	try {
		await probe.start(AbortSignal.timeout(3000));
		return true;
	} catch {
		return false;
	} finally {
		await probe[Symbol.asyncDispose]();
	}
}
