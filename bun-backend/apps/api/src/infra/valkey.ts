import { RedisClient } from 'bun';
import { isAbortOf, untilAborted } from '@starter/lib/abort';
import type { ConnectionOptions, HealthResult, Resource } from '@starter/lib/lifecycle';
import type { Logger } from '@starter/lib/log';
import { tracedChild } from '@starter/lib/tracing';

// `checkTimeoutMs` matters here: a PING queues while Valkey is down instead of failing (trap 12).
interface ValkeyOptions extends ConnectionOptions {
	connectTimeoutMs: number;
}

export class Valkey implements Resource {
	readonly name = 'valkey';
	#command: RedisClient;
	#subscriber: RedisClient | undefined;
	#log: Logger;
	#host: string;
	#connectTimeoutMs: number;
	#checkTimeoutMs: number;
	#disposal: Promise<void> | undefined;

	/** Builds the command client. Nothing connects until `start`. */
	constructor(options: ValkeyOptions) {
		this.#command = new RedisClient(options.url, {
			autoReconnect: true,
			connectionTimeout: options.connectTimeoutMs,
		});
		this.#log = options.logger.child({ component: 'valkey' });
		this.#connectTimeoutMs = options.connectTimeoutMs;
		this.#checkTimeoutMs = options.checkTimeoutMs;
		this.#host = URL.canParse(options.url) ? new URL(options.url).hostname : 'unknown';
	}

	/** Application commands. Never subscribe on it: a subscribed connection refuses commands. */
	get command(): RedisClient {
		return this.#command;
	}

	/** Own connection for pub/sub, made by `start`. */
	get subscriber(): RedisClient {
		if (!this.#subscriber) throw new Error('valkey not started');
		return this.#subscriber;
	}

	async start(signal: AbortSignal): Promise<void> {
		// With autoReconnect Bun retries a refused connection forever, so the deadline is ours.
		const limit = AbortSignal.any([signal, AbortSignal.timeout(this.#connectTimeoutMs)]);
		const closed = () => new Error('valkey closed');
		try {
			if (this.#disposal) throw closed();
			await untilAborted(this.#command.connect(), limit);
			// duplicate() opens a second connection with the same options.
			const pending = this.#command.duplicate();
			let subscriber: RedisClient;
			try {
				subscriber = await untilAborted(pending, limit);
			} catch (error) {
				// The wait lost, but the connection may still arrive; nobody would close it.
				pending.then(
					(late) => late.close(),
					() => {},
				);
				throw error;
			}
			this.#subscriber = subscriber;
			if (this.#disposal) throw closed();
			await untilAborted(this.#command.send('PING', []), limit);
			if (this.#disposal) throw closed();
		} catch (error) {
			// A failed start leaves nothing connecting in the background.
			this.#subscriber?.close();
			this.#command.close();
			if (isAbortOf(error, signal)) throw error;
			this.#log.error({ err: error }, 'valkey unreachable');
			throw new Error('valkey unreachable', { cause: error });
		}
	}

	async check(signal: AbortSignal): Promise<HealthResult> {
		if (this.#disposal) return { ok: false, detail: 'valkey closed' };
		// While the server is down the client queues commands and retries the connection, so a PING
		// would wait for it; the timeout is what makes check return promptly.
		const limit = AbortSignal.any([signal, AbortSignal.timeout(this.#checkTimeoutMs)]);
		try {
			await tracedChild(
				'valkey.command',
				{
					'db.system.name': 'valkey',
					'db.operation.name': 'PING',
					'server.address': this.#host,
				},
				() => untilAborted(this.#command.send('PING', []), limit),
				{ signal: limit },
			);
			return { ok: true };
		} catch (error) {
			return { ok: false, detail: error instanceof Error ? error.message : String(error) };
		}
	}

	[Symbol.asyncDispose](): Promise<void> {
		this.#disposal ??= (async () => {
			this.#subscriber?.close();
			this.#command.close();
			this.#log.info('valkey connections closed');
		})();
		return this.#disposal;
	}
}
