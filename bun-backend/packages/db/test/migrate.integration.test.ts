import { afterAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { silentLogger } from '@starter/lib/log';
import { migrateDatabase, type MigrateOptions } from '@starter/db/migrate';
import { appUrl, isReachable, ownerUrl } from './support.ts';

const live = await isReachable();
const migrationsFolder = `${import.meta.dir}/../migrations`;

const options = (overrides: Partial<MigrateOptions> = {}): MigrateOptions => ({
	ownerUrl,
	appUrl,
	migrationsFolder,
	connectTimeoutS: 2,
	logger: silentLogger(),
	signal: AbortSignal.timeout(20_000),
	...overrides,
});

const owner = live ? new SQL({ url: ownerUrl, max: 1 }) : undefined;
afterAll(async () => {
	await owner?.close();
});

describe.skipIf(!live)('migrateDatabase', () => {
	test('runs twice, leaving the login role a plain member of starter_app', async () => {
		await migrateDatabase(options());
		await migrateDatabase(options());
		const role = decodeURIComponent(new URL(appUrl).username);
		const [row] = await owner!`
			select rolsuper, rolbypassrls, pg_has_role(${role}, 'starter_app', 'member') as member
			from pg_roles where rolname = ${role}`;
		expect(row).toEqual({ rolsuper: false, rolbypassrls: false, member: true });
	});

	test('the login role connects', async () => {
		const sql = new SQL({ url: appUrl, max: 1, connectionTimeout: 2 });
		try {
			const [row] = await sql`select current_user as u`;
			expect(row.u).toBe(decodeURIComponent(new URL(appUrl).username));
		} finally {
			await sql.close();
		}
	});

	test('a password with a quote survives the percent-encoded URL', async () => {
		const probe = new URL(appUrl);
		probe.username = 'starter_quote_probe';
		probe.password = encodeURIComponent("it's");
		try {
			await migrateDatabase(options({ appUrl: probe.href }));
			const sql = new SQL({ url: probe.href, max: 1, connectionTimeout: 2 });
			try {
				const [row] = await sql`select current_user as u`;
				expect(row.u).toBe('starter_quote_probe');
			} finally {
				await sql.close();
			}
		} finally {
			await owner!`drop role if exists starter_quote_probe`;
		}
	});

	test('refuses a superuser as the app role and changes nothing', async () => {
		const probe = new URL(appUrl);
		probe.username = new URL(ownerUrl).username;
		probe.password = 'x';
		await expect(migrateDatabase(options({ appUrl: probe.href }))).rejects.toThrow(/superuser/);
		const [row] = await owner!`select rolsuper from pg_roles where rolname = ${probe.username}`;
		expect(row.rolsuper).toBe(true);
	});

	test('strips BYPASSRLS and the other privileges from an existing role', async () => {
		await owner!`create role starter_bypass_probe login bypassrls createdb createrole`;
		try {
			const probe = new URL(appUrl);
			probe.username = 'starter_bypass_probe';
			probe.password = 'p';
			await migrateDatabase(options({ appUrl: probe.href }));
			const [row] = await owner!`
				select rolbypassrls, rolcreatedb, rolcreaterole, rolsuper,
					pg_has_role('starter_bypass_probe', 'starter_app', 'member') as member
				from pg_roles where rolname = 'starter_bypass_probe'`;
			expect(row).toEqual({
				rolbypassrls: false,
				rolcreatedb: false,
				rolcreaterole: false,
				rolsuper: false,
				member: true,
			});
		} finally {
			await owner!`drop role if exists starter_bypass_probe`;
		}
	});
});
