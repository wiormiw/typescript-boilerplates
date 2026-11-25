import { describe, expect, test } from 'bun:test';
import { Singleflight } from '@starter/lib/singleflight';

/** Work that settles when `finish` is called, and records the signal it was given. */
function gate<T>() {
	let finish!: (value: T) => void;
	let fail!: (reason: unknown) => void;
	const promise = new Promise<T>((resolve, reject) => {
		finish = resolve;
		fail = reject;
	});
	return { promise, finish, fail };
}

const idle = () => new AbortController().signal;

describe('Singleflight', () => {
	test('concurrent callers of one key share one run and one answer', async () => {
		const flights = new Singleflight();
		const g = gate<number>();
		let runs = 0;
		const work = () => {
			runs++;
			return g.promise;
		};
		const calls = Array.from({ length: 100 }, () => flights.run('k', work, idle()));
		g.finish(7);
		expect(await Promise.all(calls)).toEqual(Array(100).fill(7));
		expect(runs).toBe(1);
	});

	test('different keys run separately', async () => {
		const flights = new Singleflight();
		let runs = 0;
		const work = async () => ++runs;
		await Promise.all([flights.run('a', work, idle()), flights.run('b', work, idle())]);
		expect(runs).toBe(2);
	});

	test('the entry is removed on settle: the next call runs again', async () => {
		const flights = new Singleflight();
		let runs = 0;
		await flights.run('k', async () => ++runs, idle());
		await flights.run('k', async () => ++runs, idle());
		expect(runs).toBe(2);
		expect(flights.size).toBe(0);
	});

	test('a failure reaches every caller and also clears the entry', async () => {
		const flights = new Singleflight();
		const g = gate<number>();
		const calls = [
			flights.run('k', () => g.promise, idle()),
			flights.run('k', () => g.promise, idle()),
		];
		const settled = Promise.allSettled(calls);
		g.fail(new Error('boom'));
		expect((await settled).map((s) => s.status)).toEqual(['rejected', 'rejected']);
		expect(flights.size).toBe(0);
		expect(await flights.run('k', async () => 1, idle())).toBe(1);
	});

	test('a caller that aborts rejects alone; the others still get the answer', async () => {
		const flights = new Singleflight();
		const g = gate<string>();
		let workSignal!: AbortSignal;
		const work = (signal: AbortSignal) => {
			workSignal = signal;
			return g.promise;
		};
		const leaving = new AbortController();
		const reason = new Error('left');
		const gone = flights.run('k', work, leaving.signal);
		const staying = flights.run('k', work, idle());
		leaving.abort(reason);
		await expect(gone).rejects.toBe(reason);
		expect(workSignal.aborted).toBe(false);
		g.finish('done');
		expect(await staying).toBe('done');
	});

	test('the work aborts when every caller has gone', async () => {
		const flights = new Singleflight();
		const g = gate<string>();
		let workSignal!: AbortSignal;
		const work = (signal: AbortSignal) => {
			workSignal = signal;
			return g.promise;
		};
		const [a, b] = [new AbortController(), new AbortController()];
		const calls = [flights.run('k', work, a.signal), flights.run('k', work, b.signal)];
		const settled = Promise.allSettled(calls);
		a.abort(new Error('a'));
		expect(workSignal.aborted).toBe(false);
		b.abort(new Error('b'));
		expect(workSignal.aborted).toBe(true);
		await settled;
		g.fail(workSignal.reason);
		await Bun.sleep(0);
		expect(flights.size).toBe(0);
	});

	test('a late joiner keeps the work alive after the first caller left', async () => {
		const flights = new Singleflight();
		const g = gate<string>();
		let runs = 0;
		let workSignal!: AbortSignal;
		const work = (signal: AbortSignal) => {
			runs++;
			workSignal = signal;
			return g.promise;
		};
		const first = new AbortController();
		const firstCall = flights.run('k', work, first.signal);
		const swallowed = firstCall.catch(() => undefined);
		const late = flights.run('k', work, idle());
		first.abort(new Error('first left'));
		await swallowed;
		expect(workSignal.aborted).toBe(false);
		g.finish('answer');
		expect(await late).toBe('answer');
		expect(runs).toBe(1);
	});

	test('a caller arriving after the work was abandoned starts a fresh run', async () => {
		const flights = new Singleflight();
		const only = new AbortController();
		const first = gate<string>();
		let workSignal!: AbortSignal;
		const abandoned = flights.run(
			'k',
			(signal) => {
				workSignal = signal;
				return first.promise;
			},
			only.signal,
		);
		const caught = abandoned.catch(() => undefined);
		only.abort(new Error('gone'));
		await caught;
		expect(workSignal.aborted).toBe(true);
		// The abandoned run is still winding down (first never settled), yet a new caller must not join it.
		expect(await flights.run('k', async () => 'fresh', idle())).toBe('fresh');
	});

	test('an aborted lifecycle signal aborts the work and rejects the callers', async () => {
		const stop = new AbortController();
		const flights = new Singleflight({ lifecycle: stop.signal });
		const g = gate<string>();
		let workSignal!: AbortSignal;
		const call = flights.run(
			'k',
			(signal) => {
				workSignal = signal;
				return g.promise;
			},
			idle(),
		);
		const settled = call.catch((e: unknown) => e);
		const reason = new Error('shutdown');
		stop.abort(reason);
		expect(workSignal.aborted).toBe(true);
		expect(await settled).toBe(reason);
	});

	test('an already aborted caller signal rejects without running anything', async () => {
		const flights = new Singleflight();
		const gone = new AbortController();
		gone.abort(new Error('early'));
		let runs = 0;
		await expect(flights.run('k', async () => ++runs, gone.signal)).rejects.toThrow('early');
		expect(runs).toBe(0);
		expect(flights.size).toBe(0);
	});
});
