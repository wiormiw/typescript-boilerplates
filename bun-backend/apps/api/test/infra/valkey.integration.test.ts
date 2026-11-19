import { RedisClient } from 'bun';
import { afterAll, describe, expect, test } from 'bun:test';
import { tracer } from '@starter/lib/tracing';
import { recordSpans } from '@starter/lib/testing';
import type { Valkey } from '#src/infra/valkey.ts';
import { isValkeyReachable, openValkey, valkeyUrl } from '../support/infra.ts';

const live = await isValkeyReachable();
const recorder = recordSpans();
const opened: Valkey[] = [];
const open = (url?: string) => {
	const valkey = openValkey(url);
	opened.push(valkey);
	return valkey;
};
afterAll(() => Promise.all(opened.map((valkey) => valkey[Symbol.asyncDispose]())));

const signal = () => AbortSignal.timeout(5000);
const until = async (done: () => Promise<boolean>, timeoutMs: number): Promise<number> => {
	const began = performance.now();
	while (performance.now() - began < timeoutMs) {
		if (await done()) return Math.round(performance.now() - began);
		await Bun.sleep(100);
	}
	throw new Error(`not satisfied within ${timeoutMs} ms`);
};

describe('create', () => {
	test('create opens no connection and dispose is idempotent', async () => {
		const valkey = open('redis://127.0.0.1:1');
		expect(valkey.name).toBe('valkey');
		await valkey[Symbol.asyncDispose]();
		await valkey[Symbol.asyncDispose]();
		expect(await valkey.check(signal())).toEqual({ ok: false, detail: 'valkey closed' });
	});
});

describe.skipIf(!live)('valkey', () => {
	test('start connects command and subscriber and check is ok', async () => {
		const valkey = open();
		await valkey.start(signal());
		expect(valkey.command).not.toBe(valkey.subscriber);
		expect(valkey.command.connected).toBe(true);
		expect(valkey.subscriber.connected).toBe(true);
		recorder.reset();
		// A probe has no request around it; it must not start a trace of its own.
		expect(await valkey.check(signal())).toEqual({ ok: true });
		expect(recorder.spans()).toEqual([]);
		// Under a request's span it is a child.
		await tracer().startActiveSpan('request', async (parent) => {
			expect(await valkey.check(signal())).toEqual({ ok: true });
			parent.end();
		});
		const span = recorder.spans().find((s) => s.name === 'valkey.command');
		expect(span?.attributes['db.system.name']).toBe('valkey');
	});

	test('start rejects with "valkey unreachable" within connectTimeoutMs + 500 ms for a closed port', async () => {
		const valkey = open('redis://127.0.0.1:1'); // connectTimeoutMs is 1000
		const began = performance.now();
		const error = await valkey.start(new AbortController().signal).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe('valkey unreachable');
		expect(performance.now() - began).toBeLessThan(1500);
	});

	test('a caller abort during start rethrows the caller reason', async () => {
		const valkey = open('redis://127.0.0.1:1');
		const reason = new Error('caller gave up');
		const controller = new AbortController();
		setTimeout(() => controller.abort(reason), 200);
		await expect(valkey.start(controller.signal)).rejects.toBe(reason);
	});

	test('a start aborted during connect leaves no open client', async () => {
		const valkey = open();
		await expect(valkey.start(AbortSignal.abort(new Error('early')))).rejects.toThrow('early');
		await Bun.sleep(300); // a late duplicate() would have resolved by now
		expect(valkey.command.connected).toBe(false);
		expect(() => valkey.subscriber).toThrow('valkey not started');
		const aborted = open();
		const controller = new AbortController();
		const starting = aborted.start(controller.signal);
		controller.abort(new Error('mid-start'));
		await expect(starting).rejects.toThrow('mid-start');
		await Bun.sleep(300);
		expect(aborted.command.connected).toBe(false);
	});

	// Pins why start needs its own deadline: Bun's connect() never rejects on a refused port.
	test('with autoReconnect, connect() to a closed port stays pending', async () => {
		const client = new RedisClient('redis://127.0.0.1:1', {
			autoReconnect: true,
			connectionTimeout: 500,
		});
		try {
			const outcome = await Promise.race([
				client.connect().then(
					() => 'settled',
					() => 'settled',
				),
				Bun.sleep(2500).then(() => 'pending'),
			]);
			expect(outcome).toBe('pending');
		} finally {
			client.close();
		}
	});

	test('subscriber receives a message published on command', async () => {
		const valkey = open();
		await valkey.start(signal());
		const channel = `starter:test:${crypto.randomUUID()}`;
		const received = Promise.withResolvers<string>();
		await valkey.subscriber.subscribe(channel, (message) => received.resolve(message));
		await valkey.command.publish(channel, 'hello');
		expect(await received.promise).toBe('hello');
	});

	test('a subscribed client throws synchronously on ordinary commands', async () => {
		const valkey = open();
		await valkey.start(signal());
		await valkey.subscriber.subscribe(`starter:test:${crypto.randomUUID()}`, () => {});
		// Not a rejected promise: the call itself throws ERR_REDIS_INVALID_STATE.
		expect(() => valkey.subscriber.set('starter:test:k', 'v')).toThrow(/subscriber mode/);
		expect(await valkey.command.get('starter:test:k')).toBeNull();
	});

	test('EVALSHA via send works after SCRIPT LOAD', async () => {
		const valkey = open();
		await valkey.start(signal());
		const sha = (await valkey.command.send('SCRIPT', [
			'LOAD',
			"return redis.call('INCRBY', KEYS[1], ARGV[1])",
		])) as string;
		const key = `starter:test:${crypto.randomUUID()}`;
		const result = await valkey.command.send('EVALSHA', [sha, '1', key, '5']);
		expect(result).toBe(5);
		await valkey.command.del(key);
	});
});

describe.skipIf(!live || Bun.env['STARTER_DOCKER_TESTS'] !== '1')('valkey outage', () => {
	// The compose container; override when the stack runs under another project name.
	const container = Bun.env['STARTER_VALKEY_CONTAINER'] ?? 'starter-valkey-1';
	const docker = async (verb: 'stop' | 'start') => {
		const proc = Bun.spawn(['docker', verb, container], { stdout: 'ignore', stderr: 'pipe' });
		if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
	};
	const healthy = (valkey: Valkey) => async () =>
		(await valkey.check(AbortSignal.timeout(2000))).ok;

	test('check reports false while Valkey is stopped and true after', async () => {
		const valkey = open(valkeyUrl);
		await valkey.start(signal());
		await docker('stop');
		try {
			const began = performance.now();
			const result = await valkey.check(AbortSignal.timeout(5000));
			const tookMs = Math.round(performance.now() - began);
			console.log('check while stopped ->', result, `${tookMs} ms`);
			expect(result.ok).toBe(false);
			expect(tookMs).toBeLessThan(1500);
			await until(async () => !(await healthy(valkey)()), 5000);
		} finally {
			await docker('start');
		}
		const recoveryMs = await until(healthy(valkey), 10_000);
		console.log('auto-reconnect recovery after start ->', recoveryMs, 'ms');
	}, 30_000);

	test('a command queued while the server is down is retried after reconnect', async () => {
		const valkey = open(valkeyUrl);
		await valkey.start(signal());
		await docker('stop');
		let outcome: string;
		try {
			await Bun.sleep(300);
			const began = performance.now();
			const pending = valkey.command.get('starter:test:inflight').then(
				(v) => `resolved ${String(v)}`,
				(error: Error) => `rejected: ${error.message}`,
			);
			await Bun.sleep(500);
			await docker('start');
			outcome = await pending;
			console.log(
				'command issued while down ->',
				outcome,
				`${Math.round(performance.now() - began)} ms`,
			);
		} finally {
			await docker('start').catch(() => {});
		}
		await until(healthy(valkey), 10_000);
		expect(outcome).toBeString();
	}, 30_000);

	test('a command already sent when the connection drops', async () => {
		const valkey = open(valkeyUrl);
		await valkey.start(signal());
		// BLPOP on an empty list is on the wire and unanswered when the server goes away.
		const pending = valkey.command
			.send('BLPOP', [`starter:test:${crypto.randomUUID()}`, '30'])
			.then(
				(v) => `resolved ${JSON.stringify(v)}`,
				(error: Error) => `rejected: ${error.message}`,
			);
		await Bun.sleep(200);
		await docker('stop');
		let outcome: string;
		try {
			outcome = await Promise.race([
				pending,
				Bun.sleep(4000).then(() => 'still pending after 4 s'),
			]);
			console.log('command on the wire when server stopped ->', outcome);
		} finally {
			await docker('start').catch(() => {});
		}
		await until(healthy(valkey), 10_000);
		expect(outcome).toBeString();
	}, 30_000);
});
