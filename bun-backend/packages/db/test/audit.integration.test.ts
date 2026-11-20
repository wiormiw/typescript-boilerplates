import { afterAll, describe, expect, test } from 'bun:test';
import { ok } from '@starter/lib/result';
import { BunSqlDatabase, asUser, audit, recordAudit } from '@starter/db';
import { withRollback } from '@starter/db/testing';
import { appUrl, isReachable, testOptions } from './support.ts';

// The app login, not the owner: the policies must hold for the role the API really connects as.
const app = new BunSqlDatabase(testOptions({ url: appUrl }));
const control = new BunSqlDatabase(testOptions({ url: appUrl }));
afterAll(async () => {
	await control[Symbol.asyncDispose]();
	await app[Symbol.asyncDispose]();
});

const live = await isReachable();
const migrated =
	live &&
	((await app.sql.unsafe(`SELECT to_regclass('public.audit') AS t`))[0]?.t as unknown) != null;

const alice = Bun.randomUUIDv7();
const bob = Bun.randomUUIDv7();
const signal = new AbortController().signal;

describe.skipIf(!migrated)('recordAudit', () => {
	test('a user reads their own rows and never another user`s', async () => {
		await withRollback(app.db, async (tx) => {
			const target = { db: tx, control: control.db };
			const as = (userId: string, operation: string) => ({ userId, signal, operation });
			await asUser(target, as(alice, 'audit.write'), async (t) => {
				await recordAudit(t, { userId: alice, action: 'sign_in', ip: '203.0.113.9' });
				return ok(null);
			});
			const seen = (userId: string) =>
				asUser(target, as(userId, 'audit.read'), async (t) => ok(await t.select().from(audit)));
			const own = await seen(alice);
			const other = await seen(bob);
			expect(own.ok && own.value.map((r) => [r.userId, r.action, r.ip])).toEqual([
				[alice, 'sign_in', '203.0.113.9'],
			]);
			expect(other.ok && other.value).toEqual([]);
		});
	});

	test('the policy refuses a row written for someone else', async () => {
		await withRollback(app.db, async (tx) => {
			const target = { db: tx, control: control.db };
			const forged = Promise.resolve(
				asUser(target, { userId: alice, signal, operation: 'audit.forge' }, async (t) => {
					await recordAudit(t, { userId: bob, action: 'sign_in' });
					return ok(null);
				}),
			);
			// Drizzle wraps the driver error; the policy's message is the cause.
			const error = await forged.then(
				() => undefined,
				(e: Error) => e,
			);
			expect(String((error?.cause as Error | undefined)?.message)).toMatch(/row-level security/);
		});
	});
});
