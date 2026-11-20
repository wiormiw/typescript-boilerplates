import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { ValidationFailed } from '@starter/lib/errors';
import { err, ok } from '@starter/lib/result';
import { BunSqlDatabase, inTransaction } from '@starter/db';
import { withRollback } from '@starter/db/testing';
import { isReachable, testOptions } from './support.ts';

const live = await isReachable();
const database = new BunSqlDatabase(testOptions());
const table = `rb_scratch_${Bun.randomUUIDv7().replaceAll('-', '')}`;

beforeAll(async () => {
	if (live) await database.sql.unsafe(`CREATE TABLE ${table} (id text PRIMARY KEY)`);
});
afterAll(async () => {
	if (live) await database.sql.unsafe(`DROP TABLE ${table}`);
	await database[Symbol.asyncDispose]();
});

describe.skipIf(!live)('withRollback', () => {
	test('what a test writes is gone afterwards, and inTransaction nests as a savepoint', async () => {
		const id = Bun.randomUUIDv7();
		const count = async (executor: { execute: typeof database.db.execute }) => {
			const rows = await executor.execute<{ n: number }>(
				sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE id = '${id}'`),
			);
			return rows[0]?.n;
		};
		const write = (executor: { execute: typeof database.db.execute }) =>
			executor.execute(sql.raw(`INSERT INTO ${table} (id) VALUES ('${id}')`));
		await withRollback(database.db, async (tx) => {
			const inner = await inTransaction(tx, async (t) => {
				await write(t);
				return err(new ValidationFailed('x'));
			});
			expect(inner.ok).toBe(false);
			// The savepoint rolled back the inner write; the outer transaction is still usable.
			expect(await count(tx)).toBe(0);
			await inTransaction(tx, async (t) => {
				await write(t);
				return ok(undefined);
			});
			expect(await count(tx)).toBe(1);
		});
		expect(await count(database.db)).toBe(0);
	});
});
