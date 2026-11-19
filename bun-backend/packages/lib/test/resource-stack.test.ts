import { describe, expect, test } from 'bun:test';
import { type HealthResult, type Resource, ResourceStack } from '../src/lifecycle.ts';

const signal = new AbortController().signal;

function fake(name: string, order: string[] = [], overrides: Partial<Resource> = {}): Resource {
	return {
		name,
		async [Symbol.asyncDispose]() {
			order.push(name);
		},
		...overrides,
	};
}

describe('ResourceStack', () => {
	test('add starts the resource before pushing it', async () => {
		const order: string[] = [];
		const stack = new ResourceStack();
		const boom = new Error('start failed');
		const bad = fake('bad', order, {
			start: () => Promise.reject(boom),
		});
		await expect(stack.add(bad, signal)).rejects.toBe(boom);
		expect(stack.names()).toEqual([]);
		expect(order).toEqual([]);

		const good = fake('good', order, {
			async start() {
				order.push('start:good');
			},
		});
		expect(await stack.add(good, signal)).toBe(good);
		expect(stack.names()).toEqual(['good']);
		expect(order).toEqual(['start:good']);
	});

	test('dispose runs in reverse order of add', async () => {
		const order: string[] = [];
		const stack = new ResourceStack();
		for (const name of ['a', 'b', 'c']) await stack.add(fake(name, order), signal);
		await stack[Symbol.asyncDispose]();
		expect(order).toEqual(['c', 'b', 'a']);
	});

	test('dispose continues past a failing resource and throws an AggregateError of the failures', async () => {
		const order: string[] = [];
		const stack = new ResourceStack();
		const failing = (name: string): Resource => ({
			name,
			async [Symbol.asyncDispose]() {
				order.push(name);
				throw new Error(`${name} failed`);
			},
		});
		await stack.add(failing('a'), signal);
		await stack.add(fake('b', order), signal);
		await stack.add(failing('c'), signal);
		const error = await stack[Symbol.asyncDispose]().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toHaveLength(2);
		expect(order).toEqual(['c', 'b', 'a']);
	});

	test('a single disposal failure is thrown as itself', async () => {
		const stack = new ResourceStack();
		const boom = new Error('only one');
		await stack.add(
			{
				name: 'a',
				[Symbol.asyncDispose]: () => Promise.reject(boom),
			},
			signal,
		);
		await expect(stack[Symbol.asyncDispose]()).rejects.toBe(boom);
	});

	test('dispose is idempotent', async () => {
		const order: string[] = [];
		const stack = new ResourceStack();
		await stack.add(fake('a', order), signal);
		const first = stack[Symbol.asyncDispose]();
		const second = stack[Symbol.asyncDispose]();
		expect(second).toBe(first);
		await first;
		await stack[Symbol.asyncDispose]();
		expect(order).toEqual(['a']);
	});

	test('drainAll calls drain in reverse order and skips resources without drain', async () => {
		const order: string[] = [];
		const stack = new ResourceStack();
		const draining = (name: string) =>
			fake(name, [], {
				async drain() {
					order.push(name);
				},
			});
		await stack.add(draining('a'), signal);
		await stack.add(fake('plain'), signal);
		await stack.add(draining('c'), signal);
		await stack.drainAll(signal);
		expect(order).toEqual(['c', 'a']);
	});

	test('checkAll runs checks concurrently and maps a throwing check to { ok: false, detail: message }', async () => {
		const stack = new ResourceStack();
		const started: string[] = [];
		const gate = Promise.withResolvers<void>();
		await stack.add(
			fake('slow', [], {
				async check(): Promise<HealthResult> {
					started.push('slow');
					await gate.promise;
					return { ok: true };
				},
			}),
			signal,
		);
		await stack.add(
			fake('broken', [], {
				async check(): Promise<HealthResult> {
					started.push('broken');
					throw new Error('db down');
				},
			}),
			signal,
		);
		const pending = stack.checkAll(signal);
		await Promise.resolve();
		await Promise.resolve();
		// Both started before the slow one finished: they run concurrently.
		expect(started.toSorted()).toEqual(['broken', 'slow']);
		gate.resolve();
		expect(await pending).toEqual({
			slow: { ok: true },
			broken: { ok: false, detail: 'db down' },
		});
	});

	test('checkAll treats a resource without check as not reported', async () => {
		const stack = new ResourceStack();
		await stack.add(fake('plain'), signal);
		await stack.add(fake('checked', [], { check: async () => ({ ok: true }) }), signal);
		expect(await stack.checkAll(signal)).toEqual({ checked: { ok: true } });
	});

	test('add after dispose rejects and does not start the resource', async () => {
		const stack = new ResourceStack();
		await stack[Symbol.asyncDispose]();
		let started = false;
		const late = fake('late', [], {
			async start() {
				started = true;
			},
		});
		await expect(stack.add(late, signal)).rejects.toThrow();
		expect(started).toBe(false);
	});

	test('a resource whose start finishes after dispose began is disposed and add rejects', async () => {
		const order: string[] = [];
		const stack = new ResourceStack();
		const gate = Promise.withResolvers<void>();
		const slow = fake('slow', order, { start: () => gate.promise });
		const adding = stack.add(slow, signal);
		const disposing = stack[Symbol.asyncDispose]();
		gate.resolve();
		await expect(adding).rejects.toThrow();
		await disposing;
		expect(order).toEqual(['slow']);
		expect(stack.names()).toEqual([]);
	});

	test('drainAll continues past a failing drain and throws the failures', async () => {
		const order: string[] = [];
		const stack = new ResourceStack();
		const draining = (name: string, fail: boolean) =>
			fake(name, [], {
				async drain() {
					order.push(name);
					if (fail) throw new Error(`${name} failed`);
				},
			});
		await stack.add(draining('a', false), signal);
		await stack.add(draining('b', true), signal);
		await stack.add(draining('c', true), signal);
		const error = await stack.drainAll(signal).catch((e: unknown) => e);
		expect(order).toEqual(['c', 'b', 'a']);
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toHaveLength(2);
	});

	test('add rejects with the signal reason when the signal is already aborted', async () => {
		const stack = new ResourceStack();
		const reason = new Error('aborted');
		const aborted = AbortSignal.abort(reason);
		await expect(stack.add(fake('a'), aborted)).rejects.toBe(reason);
		expect(stack.names()).toEqual([]);
	});
});
