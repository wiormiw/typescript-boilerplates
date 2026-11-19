import { afterEach, describe, expect, test } from 'bun:test';
import { databaseUrl, isPostgresReachable, isValkeyReachable, valkeyUrl } from './support/infra.ts';

const live = (await isPostgresReachable()) && (await isValkeyReachable());

/** Binds port 0 to find a free port, then releases it. */
function freePort(): number {
	const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
	const { port } = probe;
	probe.stop(true);
	return port;
}

interface Child {
	proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
	port: number;
	lines: Record<string, unknown>[];
	output(): string;
	exited: Promise<number>;
	url(path: string): string;
	ready(): Promise<void>;
}

const children: Child[] = [];

function spawnApi(overrides: Record<string, string> = {}): Child {
	const port = freePort();
	const proc = Bun.spawn(['bun', 'apps/api/src/main.ts'], {
		cwd: new URL('../../..', import.meta.url).pathname,
		// Explicit env, not the parent's, so no .env file or shell setting leaks in.
		env: {
			PATH: Bun.env['PATH'] ?? '',
			HOME: Bun.env['HOME'] ?? '',
			DATABASE_URL: databaseUrl,
			VALKEY_URL: valkeyUrl,
			OBSERVABILITY_LEVEL: 'off',
			LOG_LEVEL: 'debug',
			DEBUG_ROUTES: 'true',
			PORT: String(port),
			PRE_STOP_DELAY_MS: '300',
			...overrides,
		},
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	let text = '';
	const lines: Record<string, unknown>[] = [];
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		const decoder = new TextDecoder();
		let pending = '';
		for await (const chunk of stream) {
			const piece = decoder.decode(chunk, { stream: true });
			text += piece;
			pending += piece;
			let newline: number;
			while ((newline = pending.indexOf('\n')) >= 0) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				try {
					lines.push(JSON.parse(line) as Record<string, unknown>);
				} catch {
					// not a log line
				}
			}
		}
	};
	void pump(proc.stdout);
	void pump(proc.stderr);
	const child: Child = {
		proc,
		port,
		lines,
		output: () => text,
		exited: proc.exited,
		url: (path) => `http://127.0.0.1:${port}${path}`,
		async ready() {
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				if (lines.some((l) => l['msg'] === 'listening')) return;
				if (proc.exitCode !== null) throw new Error(`exited early: ${text}`);
				await Bun.sleep(25);
			}
			throw new Error(`not listening: ${text}`);
		},
	};
	children.push(child);
	return child;
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.proc.exitCode === null) child.proc.kill('SIGKILL');
		await child.proc.exited;
	}
});

const timed = async <T>(work: Promise<T>) => {
	const began = performance.now();
	const value = await work;
	return { value, ms: performance.now() - began };
};

describe.skipIf(!live)('graceful shutdown', () => {
	test('SIGTERM during a slow request lets it finish with 200 and exits 0', async () => {
		const child = spawnApi();
		await child.ready();
		const slow = fetch(child.url('/_debug/sleep?ms=1500'));
		await Bun.sleep(200);
		child.proc.kill('SIGTERM');
		const response = await slow;
		expect(response.status).toBe(200);
		expect(await child.exited).toBe(0);
	});

	test('readyz turns 503 at once after SIGTERM while healthz stays 200', async () => {
		const child = spawnApi();
		await child.ready();
		expect((await fetch(child.url('/readyz'))).status).toBe(200);
		child.proc.kill('SIGTERM');
		await Bun.sleep(100);
		expect((await fetch(child.url('/readyz'))).status).toBe(503);
		expect((await fetch(child.url('/healthz'))).status).toBe(200);
		expect(await child.exited).toBe(0);
	});

	test('a new connection after the pre-stop delay is refused', async () => {
		const child = spawnApi();
		await child.ready();
		child.proc.kill('SIGTERM');
		await Bun.sleep(600);
		const refused = await fetch(child.url('/healthz'), { keepalive: false }).then(
			() => false,
			() => true,
		);
		// The process may already have exited; either way nothing accepts.
		expect(refused).toBe(true);
		expect(await child.exited).toBe(0);
	});

	test('a second SIGTERM exits 1 immediately', async () => {
		const child = spawnApi({ PRE_STOP_DELAY_MS: '3000', DRAIN_TIMEOUT_MS: '5000' });
		await child.ready();
		child.proc.kill('SIGTERM');
		await Bun.sleep(200);
		const { value, ms } = await timed(
			(async () => {
				child.proc.kill('SIGTERM');
				return child.exited;
			})(),
		);
		expect(value).toBe(1);
		expect(ms).toBeLessThan(1000);
	});

	test('a request that outlives DRAIN_TIMEOUT_MS is cut off and the process still exits 0', async () => {
		const child = spawnApi({
			DRAIN_TIMEOUT_MS: '300',
			PRE_STOP_DELAY_MS: '100',
			SHUTDOWN_TIMEOUT_MS: '5000',
			DB_CLOSE_TIMEOUT_S: '1',
		});
		await child.ready();
		const slow = fetch(child.url('/_debug/sleep?ms=30000')).then(
			(response) => response.status,
			() => 'closed' as const,
		);
		await Bun.sleep(200);
		const began = performance.now();
		child.proc.kill('SIGTERM');
		expect(await child.exited).toBe(0);
		expect(performance.now() - began).toBeLessThan(1500);
		expect(await slow).toBe('closed');
	});
});

describe('startup failures', () => {
	test('exits 1 when the database is unreachable', async () => {
		const child = spawnApi({
			DATABASE_URL: 'postgres://postgres:x@127.0.0.1:1/none',
			DB_CONNECT_TIMEOUT_S: '2',
		});
		const { value, ms } = await timed(child.exited);
		expect(value).toBe(1);
		expect(ms).toBeLessThan((2 + 2) * 1000);
		expect(child.output()).toContain('startup failed');
	});

	test('SIGTERM during startup disposes what started', async () => {
		// Accepts the connection and never answers, so the database start hangs.
		const blackhole = Bun.listen({
			hostname: '127.0.0.1',
			port: 0,
			socket: { data() {}, open() {} },
		});
		try {
			const child = spawnApi({
				DATABASE_URL: `postgres://postgres:x@127.0.0.1:${blackhole.port}/none`,
				DB_CONNECT_TIMEOUT_S: '10',
			});
			// Only once the first resource is up: earlier, the signal handlers may not exist yet.
			const deadline = Date.now() + 10_000;
			while (
				!child.lines.some(
					(l) => l['msg'] === 'resource started' && l['resource'] === 'runtime-metrics',
				)
			) {
				if (Date.now() > deadline)
					throw new Error(`runtime-metrics never started: ${child.output()}`);
				await Bun.sleep(10);
			}
			child.proc.kill('SIGTERM');
			expect(await child.exited).toBe(0);
			const disposed = child.lines.find((l) => l['msg'] === 'resources disposed');
			expect(disposed?.['resources']).toContain('runtime-metrics');
			expect(child.output()).not.toContain('unhandled rejection');
		} finally {
			blackhole.stop(true);
		}
	});
});
