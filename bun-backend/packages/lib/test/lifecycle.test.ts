import { describe, expect, mock, test } from 'bun:test';
import { Lifecycle, handleSignals, owned } from '@starter/lib/lifecycle';
import { silentLogger } from '@starter/lib/log';
import { captureLogger } from '@starter/lib/testing';

describe('lifecycle', () => {
	test('draining fails readiness but keeps the root signal live until abort', () => {
		const life = new Lifecycle(silentLogger());
		life.markReady();
		life.beginDraining('SIGTERM');
		expect(life.isReady()).toBe(false);
		expect(life.signal.aborted).toBe(false);
		life.abort('SIGTERM');
		expect(life.signal.aborted).toBe(true);
		expect(life.isAlive()).toBe(true);
		life.markStopped();
		expect(life.isAlive()).toBe(false);
	});

	test('it starts alive, not ready, and moves through ready, draining and stopped', () => {
		const life = new Lifecycle(silentLogger());
		expect([life.phase(), life.isReady(), life.isAlive()]).toEqual(['starting', false, true]);
		life.markReady();
		expect([life.phase(), life.isReady()]).toEqual(['ready', true]);
		life.beginDraining('SIGTERM');
		expect(life.phase()).toBe('draining');
		life.markStopped();
		expect([life.phase(), life.isAlive()]).toEqual(['stopped', false]);
	});

	test('draining once stopped is ignored, and draining twice logs once', () => {
		const { logger, lines } = captureLogger();
		const life = new Lifecycle(logger);
		life.beginDraining('first');
		life.beginDraining('second');
		expect(lines.filter((l) => l['msg'] === 'draining')).toHaveLength(1);
		life.markStopped();
		life.beginDraining('late');
		expect(life.phase()).toBe('stopped');
	});

	test('abort keeps the first reason when it is called again', () => {
		const life = new Lifecycle(silentLogger());
		life.abort('SIGTERM');
		const reason = life.signal.reason;
		life.abort('another');
		expect(life.signal.reason).toBe(reason);
		expect(String(reason)).toContain('SIGTERM');
	});

	test('two lifecycles are independent', () => {
		const a = new Lifecycle(silentLogger());
		const b = new Lifecycle(silentLogger());
		a.markReady();
		a.abort('x');
		expect([b.isReady(), b.signal.aborted]).toEqual([false, false]);
	});

	test('a linked signal aborts with the root', () => {
		const life = new Lifecycle(silentLogger());
		const linked = life.linkedSignal(60_000);
		life.abort('done');
		expect(linked.aborted).toBe(true);
	});

	test('owned values release when disposed', async () => {
		const release = mock(async () => {});
		const value = owned({ name: 'pool' }, release);
		await value[Symbol.asyncDispose]();
		expect(release).toHaveBeenCalledTimes(1);
	});
});

describe('handleSignals', () => {
	test('the first signal shuts down once; a second exits at once', async () => {
		const events = new EventTarget();
		const exits: number[] = [];
		let finish!: () => void;
		const shutdown = mock(() => new Promise<void>((resolve) => (finish = resolve)));

		handleSignals({
			shutdown,
			hardExitMs: 60_000,
			logger: silentLogger(),
			exit: (code) => void exits.push(code),
			on: (signal, listener) => events.addEventListener(signal, listener),
		});

		events.dispatchEvent(new Event('SIGTERM'));
		events.dispatchEvent(new Event('SIGTERM'));
		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(exits).toEqual([1]);

		finish();
		await Bun.sleep(0);
		expect(exits).toEqual([1, 0]);
	});
});

describe('owned', () => {
	test('wrapping an already-owned value releases the inner first, then the outer', async () => {
		const order: string[] = [];
		const inner = owned({}, () => void order.push('inner'));
		const outer = owned(inner, () => void order.push('outer'));
		await outer[Symbol.asyncDispose]();
		expect(order).toEqual(['inner', 'outer']);
	});

	test('disposing twice releases once', async () => {
		let released = 0;
		const value = owned({}, () => void released++);
		await Promise.all([value[Symbol.asyncDispose](), value[Symbol.asyncDispose]()]);
		await value[Symbol.asyncDispose]();
		expect(released).toBe(1);
	});
});
