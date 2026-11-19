import { afterAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { BunSqlDatabase } from '@starter/db';
import { pgArray } from '@starter/db/sql';
import { isReachable, testOptions } from './support.ts';

/** What `current_setting` and `pg_backend_pid()` read back in the `SET LOCAL` tests. */
type Row = { value: string | null; pid: number };

// Each test name states a fact about Bun SQL (or drizzle on it) that the code relies on. When a
// Bun or drizzle upgrade breaks one, the rule that depends on it needs revisiting.

const live = await isReachable();
const database = BunSqlDatabase.create(testOptions({ poolMax: 4 }));
afterAll(() => database[Symbol.asyncDispose]());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!live)('Bun SQL traps', () => {
	test('run() cancels pg_sleep(5) within 500 ms of abort and the backend is no longer active', async () => {
		const controller = new AbortController();
		const reason = new Error('caller gave up');
		const running = database.run(
			database.sql`SELECT pg_sleep(5) /* starter-trap-cancel */`,
			controller.signal,
		);
		// Handled up front so the rejection is never unhandled while the test polls.
		const outcome = running.then(
			() => 'resolved' as const,
			(error: unknown) => error,
		);
		const activeCount = async () => {
			const rows = await database.sql<{ n: number }[]>`
				SELECT count(*)::int AS n FROM pg_stat_activity
				WHERE state = 'active' AND pid <> pg_backend_pid()
				AND query LIKE '%starter-trap-cancel%'`;
			return rows[0]?.n;
		};
		for (let i = 0; i < 50 && (await activeCount()) !== 1; i++) await sleep(20);
		expect(await activeCount()).toBe(1);

		const began = performance.now();
		controller.abort(reason);
		const settled = await outcome;
		const elapsed = performance.now() - began;
		expect(elapsed).toBeLessThan(500);
		expect(settled).toBe(reason);
		expect(await activeCount()).toBe(0);
	});

	test('a JS array in a drizzle sql template expands to a parameter list; pgArray binds one array', async () => {
		const values = ['a', 'b', 'c'];
		// `($1, $2, $3)::text[]` is a row cast, which Postgres refuses; one array parameter would
		// have worked.
		await expect(
			Promise.resolve(database.db.execute(sql`SELECT ${values}::text[] AS got`)),
		).rejects.toThrow(/\(\$1, \$2, \$3\)::text\[\]/);

		const rows = await database.db.execute<{ got: string[]; size: number }>(
			sql`SELECT ${pgArray(['a', 'b"q', 'c,d'])}::text[] AS got, cardinality(${pgArray(['a', 'b'])}::text[]) AS size`,
		);
		expect(rows[0]).toEqual({ got: ['a', 'b"q', 'c,d'], size: 2 });
	});

	test('a Bun SQL query is a lazy thenable: expect(Promise.resolve(q)).rejects works', async () => {
		const query = database.sql`SELECT pg_sleep(1)`;
		// Not sent until something awaits it.
		expect(query.active).toBe(false);
		const limited = BunSqlDatabase.create(
			testOptions({
				poolMax: 1,
				limits: { statementTimeoutMs: 50, lockTimeoutMs: 50, idleInTransactionTimeoutMs: 1000 },
			}),
		);
		try {
			await expect(Promise.resolve(limited.sql`SELECT pg_sleep(1)`)).rejects.toThrow(
				/statement timeout/,
			);
		} finally {
			await limited[Symbol.asyncDispose]();
		}
	});

	test('LISTEN/NOTIFY: sql.listen receives a NOTIFY', async () => {
		const channel = `trap_${Bun.randomUUIDv7().replaceAll('-', '')}`;
		const received = Promise.withResolvers<string>();
		await database.sql.listen(channel, (payload) => received.resolve(payload));
		await database.sql.notify(channel, 'hello');
		const payload = await Promise.race([received.promise, sleep(3000).then(() => 'timed out')]);
		expect(payload).toBe('hello');
	});

	test('SET LOCAL inside db.transaction is visible to later statements in the same transaction and reads as empty string on the same connection after commit', async () => {
		// One connection, so the read after commit provably hits the backend that had the setting.
		const single = BunSqlDatabase.create(testOptions({ poolMax: 1 }));
		try {
			const setting = 'app.user_id';
			const read = sql`SELECT current_setting(${setting}, true) AS value, pg_backend_pid() AS pid`;
			const inside = await single.db.transaction(async (tx) => {
				await tx.execute(sql.raw(`SET LOCAL ${setting} = 'u1'`));
				const first = await tx.execute<Row>(read);
				const second = await tx.execute<Row>(read);
				return [first[0], second[0]];
			});
			expect(inside.map((row) => row?.value)).toEqual(['u1', 'u1']);
			const after = await single.db.execute<Row>(read);
			expect(after[0]?.pid).toBe(inside[0]?.pid ?? -1);
			expect(after[0]?.value).toBe('');
		} finally {
			await single[Symbol.asyncDispose]();
		}
	});

	test('set_config with a bound parameter is transaction-local and reads as empty string on the same connection after commit', async () => {
		const single = BunSqlDatabase.create(testOptions({ poolMax: 1 }));
		try {
			// A value that would break out of a quoted `sql.raw` string, bound instead of interpolated.
			const id = `u1'; select 'pwned`;
			const read = sql`SELECT current_setting('app.user_id', true) AS value, pg_backend_pid() AS pid`;
			const inside = await single.db.transaction(async (tx) => {
				await tx.execute(sql`select set_config('app.user_id', ${id}, true)`);
				return (await tx.execute<Row>(read))[0];
			});
			expect(inside?.value).toBe(id);
			const after = await single.db.execute<Row>(read);
			expect(after[0]?.pid).toBe(inside?.pid ?? -1);
			expect(after[0]?.value).toBe('');
		} finally {
			await single[Symbol.asyncDispose]();
		}
	});
});
