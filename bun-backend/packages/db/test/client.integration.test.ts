import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { tracer } from '@starter/lib/tracing';
import { captureLogger, recordSpans } from '@starter/lib/testing';
import { BunSqlDatabase } from '@starter/db';
import { isReachable, testOptions, url } from './support.ts';

const live = await isReachable();
const recorder = recordSpans();
const opened: BunSqlDatabase[] = [];
const open = (...args: Parameters<typeof testOptions>) => {
	const database = BunSqlDatabase.create(testOptions(...args));
	opened.push(database);
	return database;
};
afterAll(() => Promise.all(opened.map((database) => database[Symbol.asyncDispose]())));

const signal = () => AbortSignal.timeout(5000);

describe('create', () => {
	test('create opens no connection and is idempotent to dispose', async () => {
		const database = open({ url: 'postgres://nobody:nothing@127.0.0.1:1/none' });
		expect(database.name).toBe('database');
		await database[Symbol.asyncDispose]();
	});
});

describe.skipIf(!live)('database', () => {
	test('start succeeds against compose postgres', async () => {
		const database = open();
		await database.start(signal());
		expect(await database.check(signal())).toEqual({ ok: true });
	});

	test('start rejects with "database unreachable" for a closed port within connectTimeoutS + 1 s', async () => {
		const database = open({ url: 'postgres://postgres:x@127.0.0.1:1/none', connectTimeoutS: 1 });
		const began = performance.now();
		await expect(database.start(signal())).rejects.toThrow('database unreachable');
		expect(performance.now() - began).toBeLessThan(2000);
	});

	test('check records no span without a parent, and a child span under one', async () => {
		const database = open();
		await database.start(signal());
		recorder.reset();
		expect(await database.check(signal())).toEqual({ ok: true });
		expect(recorder.spans()).toEqual([]);
		await tracer().startActiveSpan('request', async (parent) => {
			await database.check(signal());
			parent.end();
		});
		expect(recorder.spans().map((s) => s.name)).toContain('db.query');
	});

	test('check fails within ~1.5 s when the pool is exhausted', async () => {
		const database = open({ poolMax: 1 });
		await database.start(signal());
		// Holds the only connection, so the check's query queues behind it.
		const held = await database.sql.reserve();
		try {
			const began = performance.now();
			const health = await database.check(signal());
			expect(health.ok).toBe(false);
			expect(performance.now() - began).toBeLessThan(1500);
		} finally {
			held.release();
		}
	});

	test('check is false after dispose', async () => {
		const database = open();
		await database.start(signal());
		await database[Symbol.asyncDispose]();
		const health = await database.check(signal());
		expect(health).toEqual({ ok: false, detail: 'database closed' });
	});

	test('dispose twice closes once', async () => {
		const database = open();
		await database.start(signal());
		const close = spyOn(database.sql, 'close');
		const first = database[Symbol.asyncDispose]();
		const second = database[Symbol.asyncDispose]();
		expect(second).toBe(first);
		await first;
		await database[Symbol.asyncDispose]();
		expect(close).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledWith({ timeout: 2 });
	});

	test('run rejects with the signal reason without sending the query when already aborted', async () => {
		const database = open();
		const aborted = AbortSignal.abort(new Error('stop'));
		const query = database.sql`SELECT 1`;
		await expect(database.run(query, aborted)).rejects.toThrow('stop');
		expect(query.active).toBe(false);
	});

	test('run returns rows and records a db.query span with its operation and server address', async () => {
		recorder.reset();
		const database = open();
		const rows = await database.run(database.sql`SELECT 1 AS one`, signal(), 'select');
		expect(rows[0]).toEqual({ one: 1 });
		const span = recorder.spans().find((s) => s.name === 'db.query');
		expect(span?.attributes['db.system.name']).toBe('postgresql');
		expect(span?.attributes['db.operation.name']).toBe('select');
		expect(span?.attributes['server.address']).toBe(new URL(url).hostname);
	});

	test('a query over slowQueryMs is logged at warn with operation and duration, never parameters', async () => {
		const { logger, lines } = captureLogger();
		const database = open({ slowQueryMs: 0, logger });
		await database.run(database.sql`SELECT ${'s3cret-value'}::text AS v`, signal(), 'select');
		const slow = lines.find((line) => line['msg'] === 'slow query');
		expect(slow?.['level']).toBe(40);
		expect(slow?.['operation']).toBe('select');
		expect(typeof slow?.['durationMs']).toBe('number');
		expect(JSON.stringify(lines)).not.toContain('s3cret-value');
	});

	test('statement timeout is enforced by Postgres', async () => {
		const database = open({
			poolMax: 1,
			limits: { statementTimeoutMs: 50, lockTimeoutMs: 50, idleInTransactionTimeoutMs: 1000 },
		});
		await expect(database.run(database.sql`SELECT pg_sleep(1)`, signal())).rejects.toThrow(
			/statement timeout/,
		);
	});
});
