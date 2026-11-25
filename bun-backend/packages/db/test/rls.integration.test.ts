import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { ValidationFailed } from '@starter/lib/errors';
import { err, ok } from '@starter/lib/result';
import { BunSqlDatabase, asUser } from '@starter/db';
import { appUrl, isReachable, testOptions } from './support.ts';

const live = await isReachable();
const owner = new BunSqlDatabase(testOptions());
const app = new BunSqlDatabase(testOptions({ url: appUrl, poolMax: 2 }));
// One connection: a leaked transaction or a statement still running would starve it.
const single = new BunSqlDatabase(testOptions({ url: appUrl, poolMax: 1 }));
const table = `rls_probe_${Bun.randomUUIDv7().replaceAll('-', '')}`;
const POLICY = `user_id = nullif(current_setting('app.user_id', true), '')::uuid`;
const alice = Bun.randomUUIDv7();
const bob = Bun.randomUUIDv7();
const never = new AbortController().signal;

const insert = (tx: { execute: (q: ReturnType<typeof sql.raw>) => unknown }, userId: string) =>
	tx.execute(
		sql.raw(`INSERT INTO ${table} (id, user_id) VALUES ('${Bun.randomUUIDv7()}', '${userId}')`),
	);
const count = async (db: BunSqlDatabase) => {
	const rows = await db.sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`);
	return rows[0].n as number;
};

beforeAll(async () => {
	if (!live) return;
	await owner.sql.unsafe(`CREATE TABLE ${table} (id uuid PRIMARY KEY, user_id uuid NOT NULL)`);
	await owner.sql.unsafe(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
	await owner.sql.unsafe(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
	await owner.sql.unsafe(`CREATE POLICY own ON ${table} USING (${POLICY}) WITH CHECK (${POLICY})`);
});
afterAll(async () => {
	if (live) await owner.sql.unsafe(`DROP TABLE ${table}`);
	await single[Symbol.asyncDispose]();
	await app[Symbol.asyncDispose]();
	await owner[Symbol.asyncDispose]();
});

describe.skipIf(!live)('asUser', () => {
	test('names its backend before the work runs, and the pool carries its application_name', async () => {
		const named = new BunSqlDatabase(
			testOptions({ url: appUrl, poolMax: 1, applicationName: 'starter-test-named' }),
		);
		try {
			const pids: number[] = [];
			const result = await asUser(
				named,
				{ userId: alice, signal: never, operation: 'select', onBackend: (pid) => pids.push(pid) },
				async (tx) => {
					const rows = await tx.execute<{ pid: number; name: string }>(
						sql`select pg_backend_pid() as pid, current_setting('application_name') as name`,
					);
					return ok(rows[0]!);
				},
			);
			expect(result.ok && result.value.name).toBe('starter-test-named');
			expect(pids).toEqual([result.ok ? result.value.pid : -1]);
		} finally {
			await named[Symbol.asyncDispose]();
		}
	});

	test('returns only the caller rows', async () => {
		await asUser(app, { userId: alice, signal: never, operation: 'insert' }, async (tx) => {
			await insert(tx, alice);
			return ok(null);
		});
		await asUser(app, { userId: bob, signal: never, operation: 'insert' }, async (tx) => {
			await insert(tx, bob);
			await insert(tx, bob);
			return ok(null);
		});
		const seen = (userId: string) =>
			asUser(app, { userId, signal: never, operation: 'select' }, async (tx) => {
				const rows = await tx.execute<{ user_id: string }>(sql.raw(`SELECT user_id FROM ${table}`));
				return ok(rows.map((r) => r.user_id));
			});
		const a = await seen(alice);
		const b = await seen(bob);
		expect(a.ok && a.value).toEqual([alice]);
		expect(b.ok && b.value).toEqual([bob, bob]);
	});

	test('an err result rolls back the insert', async () => {
		const before = await count(owner);
		const result = await asUser(
			app,
			{ userId: alice, signal: never, operation: 'insert' },
			async (tx) => {
				await insert(tx, alice);
				return err(new ValidationFailed('Nope.'));
			},
		);
		expect(result.ok).toBe(false);
		expect(await count(owner)).toBe(before);
	});

	test('an abort during pg_sleep(5) rejects with the reason in under 1 s and the statement is gone', async () => {
		const controller = new AbortController();
		const reason = new Error('caller gave up');
		const began = performance.now();
		const running = asUser(
			single,
			{ userId: alice, signal: controller.signal, operation: 'sleep' },
			async (tx) => {
				await tx.execute(sql`SELECT pg_sleep(5)`);
				return ok(null);
			},
		).then(
			() => 'resolved' as const,
			(error: unknown) => error,
		);
		await Bun.sleep(150);
		controller.abort(reason);
		expect(await running).toBe(reason);
		expect(performance.now() - began).toBeLessThan(1000);
		// The only connection answers at once: the cancel reached the server and the transaction ended.
		expect(await count(single)).toBe(0);
		const active = await owner.sql`
			SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%pg_sleep(5)%'
			AND pid <> pg_backend_pid()`;
		expect(active[0].n).toBe(0);
	});

	test('a signal aborted beforehand rejects without a query', async () => {
		const reason = new Error('already gone');
		const result = await asUser(
			single,
			{ userId: alice, signal: AbortSignal.abort(reason), operation: 'select' },
			async () => ok(null),
		).then(
			() => 'resolved' as const,
			(error: unknown) => error,
		);
		expect(result).toBe(reason);
		expect(await count(single)).toBeGreaterThanOrEqual(0);
	});

	test('an abort between statements rolls back and rejects with the reason', async () => {
		const controller = new AbortController();
		const reason = new Error('late abort');
		const id = Bun.randomUUIDv7();
		const outcome = await asUser(
			app,
			{ userId: alice, signal: controller.signal, operation: 'insert' },
			async (tx) => {
				await tx.execute(
					sql.raw(`INSERT INTO ${table} (id, user_id) VALUES ('${id}', '${alice}')`),
				);
				controller.abort(reason);
				return ok(null);
			},
		).then(
			() => 'resolved' as const,
			(error: unknown) => error,
		);
		expect(outcome).toBe(reason);
		const rows = await owner.sql.unsafe(`SELECT id FROM ${table} WHERE id = '${id}'`);
		expect(rows).toHaveLength(0);
	});
});
