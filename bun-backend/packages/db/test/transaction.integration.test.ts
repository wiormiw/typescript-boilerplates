import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { Unauthenticated, ValidationFailed } from '@starter/lib/errors';
import { err, ok, type Result } from '@starter/lib/result';
import { BunSqlDatabase, inTransaction } from '@starter/db';
import { isReachable, testOptions } from './support.ts';

const live = await isReachable();
const database = new BunSqlDatabase(testOptions());
const table = `tx_scratch_${Bun.randomUUIDv7().replaceAll('-', '')}`;
const count = async (id: string) => {
	const rows = await database.db.execute<{ n: number }>(
		sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE id = '${id}'`),
	);
	return rows[0]?.n;
};
const insert = (executor: { execute: (q: ReturnType<typeof sql.raw>) => unknown }, id: string) =>
	executor.execute(sql.raw(`INSERT INTO ${table} (id) VALUES ('${id}')`));

beforeAll(async () => {
	if (live) await database.sql.unsafe(`CREATE TABLE ${table} (id text PRIMARY KEY)`);
});
afterAll(async () => {
	if (live) await database.sql.unsafe(`DROP TABLE ${table}`);
	await database[Symbol.asyncDispose]();
});

describe.skipIf(!live)('inTransaction', () => {
	test('a returned err rolls back rows written before it', async () => {
		const id = Bun.randomUUIDv7();
		const result = await inTransaction(database.db, async (tx) => {
			await insert(tx, id);
			return err(new ValidationFailed('Taken.'));
		});
		expect(result.ok).toBe(false);
		expect(await count(id)).toBe(0);
	});

	test('a returned error class comes back as itself, its union intact', async () => {
		const refuse = async (): Promise<Result<string, ValidationFailed | Unauthenticated>> =>
			err(new ValidationFailed('Taken.'));
		const result: Result<string, ValidationFailed | Unauthenticated> = await inTransaction(
			database.db,
			refuse,
		);
		expect(!result.ok && result.error).toBeInstanceOf(ValidationFailed);
	});

	test('an ok commits its rows', async () => {
		const id = Bun.randomUUIDv7();
		const result = await inTransaction(database.db, async (tx) => {
			await insert(tx, id);
			return ok(id);
		});
		expect(result).toEqual(ok(id));
		expect(await count(id)).toBe(1);
	});
});
