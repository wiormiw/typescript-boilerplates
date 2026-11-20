import { describe, expect, test } from 'bun:test';
import { isAbortError, isAbortOf, isTimeout, untilAborted } from '@starter/lib/abort';

const never = () => new Promise<never>(() => {});

describe('untilAborted', () => {
	test('without a signal it is the work itself', async () => {
		expect(await untilAborted(Promise.resolve(7), undefined)).toBe(7);
	});

	test("the work's own answer or failure comes through untouched", async () => {
		const signal = new AbortController().signal;
		expect(await untilAborted(Promise.resolve(7), signal)).toBe(7);
		await expect(untilAborted(Promise.reject(new Error('boom')), signal)).rejects.toThrow('boom');
	});

	test("stops waiting when the signal aborts, with the signal's reason", async () => {
		const controller = new AbortController();
		const waiting = untilAborted(never(), controller.signal);
		controller.abort(new Error('deadline'));
		await expect(waiting).rejects.toThrow('deadline');
	});

	test('an already aborted signal rejects at once, and the work failing later is still handled', async () => {
		const controller = new AbortController();
		controller.abort(new Error('gone'));
		const { promise: work, reject: fail } = Promise.withResolvers<never>();
		await expect(untilAborted(work, controller.signal)).rejects.toThrow('gone');
		// If this rejection were unhandled, bun would report it and fail the run.
		fail(new Error('late'));
		await Bun.sleep(0);
	});

	test('a timeout signal ends the wait on its own', async () => {
		const started = performance.now();
		await expect(untilAborted(never(), AbortSignal.timeout(30))).rejects.toMatchObject({
			name: 'TimeoutError',
		});
		expect(performance.now() - started).toBeLessThan(500);
	});
});

describe('isAbortOf', () => {
	test("tells the signal's own abort apart from any other failure", () => {
		const controller = new AbortController();
		const reason = new Error('deadline');
		expect(isAbortOf(reason, controller.signal)).toBe(false);
		controller.abort(reason);
		expect(isAbortOf(reason, controller.signal)).toBe(true);
		expect(isAbortOf(new Error('deadline'), controller.signal)).toBe(false);
		expect(isAbortOf(reason, undefined)).toBe(false);
	});
});

describe('isAbortError and isTimeout', () => {
	// Libraries and polyfills throw a plain Error with the name; the platform throws a DOMException.
	const plain = (name: string) => Object.assign(new Error('x'), { name });

	test('an AbortError is recognised as a DOMException or as a plain Error', () => {
		expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
		expect(isAbortError(plain('AbortError'))).toBe(true);
	});

	test('a TimeoutError is recognised as a DOMException or as a plain Error', async () => {
		expect(isTimeout(new DOMException('x', 'TimeoutError'))).toBe(true);
		expect(isTimeout(plain('TimeoutError'))).toBe(true);
		const deadline = AbortSignal.timeout(1);
		await Bun.sleep(10);
		expect(isTimeout(deadline.reason)).toBe(true);
	});

	test('anything else is neither', () => {
		for (const other of [new Error('x'), new TypeError('x'), 'AbortError', null, undefined, {}]) {
			expect(isAbortError(other)).toBe(false);
			expect(isTimeout(other)).toBe(false);
		}
		expect(isAbortError(new DOMException('x', 'TimeoutError'))).toBe(false);
		expect(isTimeout(new DOMException('x', 'AbortError'))).toBe(false);
	});
});
