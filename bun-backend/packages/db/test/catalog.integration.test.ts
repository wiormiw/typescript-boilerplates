import { afterAll, describe, expect, test } from 'bun:test';
import { BunSqlDatabase } from '@starter/db';
import { isReachable, testOptions } from './support.ts';

// Runs as the owner: it reads the catalogs and asks has_table_privilege about the app role.
const owner = new BunSqlDatabase(testOptions());
afterAll(() => owner[Symbol.asyncDispose]());

const live = await isReachable();
const migrated =
	live &&
	((await owner.sql.unsafe(`SELECT to_regclass('drizzle.__drizzle_migrations') AS t`))[0]
		?.t as unknown) != null;

// better-auth reads these outside asUser and filters by user itself, so they carry no policy.
const AUTH_OWNED = ['session', 'account'];

describe.skipIf(!migrated)('the catalog', () => {
	test('every table with a user_id column forces row-level security behind a policy', async () => {
		const rows = (await owner.sql.unsafe(
			`SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
				(SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
			FROM pg_class c
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'public' AND c.relkind = 'r'
				AND EXISTS (
					SELECT 1 FROM pg_attribute a
					WHERE a.attrelid = c.oid AND a.attname = 'user_id' AND NOT a.attisdropped)
				AND c.relname <> ALL ($1::text[])
			ORDER BY c.relname`,
			[`{${AUTH_OWNED.join(',')}}`],
		)) as { name: string; rls: boolean; forced: boolean; policies: number }[];
		// The rule is vacuous on an empty set, so name the tables it must see.
		expect(rows.map((r) => r.name)).toEqual(['audit', 'user_settings']);
		for (const r of rows) {
			expect({ table: r.name, rls: r.rls, forced: r.forced, policy: r.policies > 0 }).toEqual({
				table: r.name,
				rls: true,
				forced: true,
				policy: true,
			});
		}
	});

	test('the API roles own no table', async () => {
		const rows = await owner.sql.unsafe(
			`SELECT tablename FROM pg_tables
			WHERE schemaname = 'public' AND tableowner IN ('starter_api', 'starter_app')`,
		);
		expect(rows.map((r: { tablename: string }) => r.tablename)).toEqual([]);
	});

	test('the app role can select, insert, update and delete on every table', async () => {
		const rows = (await owner.sql.unsafe(
			`SELECT tablename AS name,
				has_table_privilege('starter_app', format('public.%I', tablename), 'SELECT') AS sel,
				has_table_privilege('starter_app', format('public.%I', tablename), 'INSERT') AS ins,
				has_table_privilege('starter_app', format('public.%I', tablename), 'UPDATE') AS upd,
				has_table_privilege('starter_app', format('public.%I', tablename), 'DELETE') AS del
			FROM pg_tables WHERE schemaname = 'public'
			ORDER BY tablename`,
		)) as { name: string; sel: boolean; ins: boolean; upd: boolean; del: boolean }[];
		expect(rows.map((r) => r.name)).toEqual(
			expect.arrayContaining(['account', 'audit', 'session', 'user', 'user_settings']),
		);
		for (const r of rows) {
			expect({ ...r }).toEqual({ name: r.name, sel: true, ins: true, upd: true, del: true });
		}
	});
});
