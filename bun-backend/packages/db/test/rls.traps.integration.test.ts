import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BunSqlDatabase } from '@starter/db';
import { appUrl, isReachable, testOptions } from './support.ts';

// Each test pins a Postgres fact that row-level security relies on. A failure here means a
// premise of the auth slice is false.

const live = await isReachable();
const owner = new BunSqlDatabase(testOptions());
const app = new BunSqlDatabase(testOptions({ url: appUrl, poolMax: 2 }));
const suffix = Bun.randomUUIDv7().replaceAll('-', '');
const parent = `rls_trap_parent_${suffix}`;
const child = `rls_trap_child_${suffix}`;
const alice = Bun.randomUUIDv7();
const bob = Bun.randomUUIDv7();
const POLICY = `user_id = nullif(current_setting('app.user_id', true), '')::uuid`;

beforeAll(async () => {
	if (!live) return;
	await owner.sql.unsafe(`CREATE TABLE ${parent} (id uuid PRIMARY KEY)`);
	await owner.sql.unsafe(
		`CREATE TABLE ${child} (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES ${parent}(id) ON DELETE CASCADE)`,
	);
	await owner.sql.unsafe(`ALTER TABLE ${child} ENABLE ROW LEVEL SECURITY`);
	await owner.sql.unsafe(`ALTER TABLE ${child} FORCE ROW LEVEL SECURITY`);
	await owner.sql.unsafe(`CREATE POLICY own ON ${child} USING (${POLICY}) WITH CHECK (${POLICY})`);
	await owner.sql.unsafe(`INSERT INTO ${parent} (id) VALUES ('${alice}'), ('${bob}')`);
	await owner.sql.unsafe(
		`INSERT INTO ${child} (id, user_id) VALUES ('${Bun.randomUUIDv7()}', '${alice}'), ('${Bun.randomUUIDv7()}', '${bob}')`,
	);
});
afterAll(async () => {
	if (live) {
		await owner.sql.unsafe(`DROP TABLE ${child}`);
		await owner.sql.unsafe(`DROP TABLE ${parent}`);
	}
	await app[Symbol.asyncDispose]();
	await owner[Symbol.asyncDispose]();
});

describe.skipIf(!live)('RLS traps', () => {
	test('a superuser owner sees every row despite FORCE ROW LEVEL SECURITY; the app login sees its own', async () => {
		const all = await owner.sql.unsafe(`SELECT user_id FROM ${child}`);
		expect(all).toHaveLength(2);
		const mine = await app.sql.begin(async (tx) => {
			await tx`SELECT set_config('app.user_id', ${alice}, true)`;
			return tx.unsafe(`SELECT user_id FROM ${child}`);
		});
		expect(mine.map((r: { user_id: string }) => r.user_id)).toEqual([alice]);
	});

	test("after a committed set_config(..., true) the setting reads '' on the same backend and the nullif policy matches nothing", async () => {
		const reserved = await app.sql.reserve();
		try {
			await reserved.begin(async (tx) => {
				await tx`SELECT set_config('app.user_id', ${alice}, true)`;
			});
			const [row] = await reserved`SELECT current_setting('app.user_id', true) AS value`;
			expect(row.value).toBe('');
			const rows = await reserved.unsafe(`SELECT user_id FROM ${child}`);
			expect(rows).toHaveLength(0);
		} finally {
			reserved.release();
		}
	});

	test('pg_cancel_backend from a second connection cancels pg_sleep(5) within 500 ms with errno 57014', async () => {
		const victim = await app.sql.reserve();
		try {
			const [{ pid }] = await victim`SELECT pg_backend_pid() AS pid`;
			const sleeping = Promise.resolve(victim`SELECT pg_sleep(5)`).then(
				() => 'resolved' as const,
				(error: unknown) => error,
			);
			await Bun.sleep(100);
			const began = performance.now();
			await app.sql`SELECT pg_cancel_backend(${pid})`;
			const outcome = await sleeping;
			const elapsed = performance.now() - began;
			expect(outcome).toMatchObject({ errno: '57014' });
			expect(elapsed).toBeLessThan(500);
		} finally {
			victim.release();
		}
	});

	test('ON DELETE CASCADE from a non-RLS parent deletes RLS child rows whatever app.user_id is', async () => {
		const other = Bun.randomUUIDv7();
		const row = Bun.randomUUIDv7();
		await owner.sql.unsafe(`INSERT INTO ${parent} (id) VALUES ('${other}')`);
		await owner.sql.unsafe(`INSERT INTO ${child} (id, user_id) VALUES ('${row}', '${other}')`);
		await app.sql.begin(async (tx) => {
			await tx`SELECT set_config('app.user_id', ${alice}, true)`;
			await tx.unsafe(`DELETE FROM ${parent} WHERE id = '${other}'`);
		});
		const left = await owner.sql.unsafe(`SELECT id FROM ${child} WHERE id = '${row}'`);
		expect(left).toHaveLength(0);
	});
});
