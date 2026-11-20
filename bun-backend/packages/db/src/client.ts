import { SQL } from 'bun';
import { drizzle } from 'drizzle-orm/bun-sql';
import { isAbortOf } from '@starter/lib/abort';
import type { HealthResult, Resource } from '@starter/lib/lifecycle';
import type { Logger } from '@starter/lib/log';
import { tracedChild, traced } from '@starter/lib/tracing';
import { operationDuration } from './metrics.ts';
import { relations } from './relations.ts';
import type { DatabaseOptions, Db } from './types.ts';
export type { DatabaseOptions, Db, Tx, Executor } from './types.ts';

export const connect = (sql: SQL) => drizzle({ client: sql, relations });

export class BunSqlDatabase implements Resource {
	readonly name = 'database';
	#sql: SQL;
	#db: Db;
	#control: SQL;
	#controlDb: Db;
	#options: DatabaseOptions;
	#log: Logger;
	#host: string;
	#duration = operationDuration();
	#disposal: Promise<void> | undefined;

	/** Opens a pool object. Nothing connects until the first query; `start` fails fast. */
	constructor(options: DatabaseOptions) {
		// Infrastructure closes idle connections without telling the client; recycle first.
		const connections = {
			url: options.url,
			idleTimeout: options.idleTimeoutS,
			maxLifetime: options.maxLifetimeS,
			connectionTimeout: options.connectTimeoutS,
		};
		this.#sql = new SQL({
			...connections,
			max: options.poolMax,
			...(options.limits && {
				connection: {
					statement_timeout: options.limits.statementTimeoutMs,
					lock_timeout: options.limits.lockTimeoutMs,
					idle_in_transaction_session_timeout: options.limits.idleInTransactionTimeoutMs,
				},
			}),
		});
		this.#db = connect(this.#sql);
		// Cancels travel on their own connection: the work pool may be saturated by the very
		// statement being cancelled.
		this.#control = new SQL({ ...connections, max: 1 });
		this.#controlDb = connect(this.#control);
		this.#options = options;
		this.#log = options.logger.child({ component: 'db' });
		this.#host = URL.canParse(options.url) ? new URL(options.url).hostname : 'unknown';
	}

	get db(): Db {
		return this.#db;
	}

	/** A separate one-connection pool for cancel requests; see `asUser`. */
	get control(): Db {
		return this.#controlDb;
	}

	get sql(): SQL {
		return this.#sql;
	}

	/** Proves the connection works. It does not prove the schema is migrated. */
	async start(signal: AbortSignal): Promise<void> {
		try {
			await this.run(this.#sql`SELECT 1`, signal, 'select');
		} catch (error) {
			if (isAbortOf(error, signal)) throw error;
			this.#log.error({ err: error }, 'database unreachable');
			throw new Error('database unreachable', { cause: error });
		}
	}

	async check(signal: AbortSignal): Promise<HealthResult> {
		if (this.#disposal) return { ok: false, detail: 'database closed' };
		// A saturated pool queues the query behind busy connections, so the check bounds its own wait.
		const limit = AbortSignal.any([signal, AbortSignal.timeout(this.#options.checkTimeoutMs)]);
		try {
			await this.#execute(this.#sql`SELECT 1`, limit, 'select', tracedChild);
			return { ok: true };
		} catch (error) {
			return { ok: false, detail: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * Runs a query under `signal`: an abort cancels it server-side and rejects with the signal's
	 * reason. A Bun query is lazy, so one aborted beforehand is never sent. Bun exposes no query
	 * text, so the caller names the `operation` (the SQL's first keyword) for spans and metrics.
	 */
	run<T>(query: SQL.Query<T>, signal: AbortSignal, operation = 'query'): Promise<T> {
		return this.#execute(query, signal, operation, traced);
	}

	// `span` is `traced`, or `tracedChild` for probes that must not start a trace of their own.
	async #execute<T>(
		query: SQL.Query<T>,
		signal: AbortSignal,
		operation: string,
		span: typeof traced,
	): Promise<T> {
		signal.throwIfAborted();
		const attributes = {
			'db.system.name': 'postgresql',
			'db.operation.name': operation,
			'server.address': this.#host,
		};
		const began = performance.now();
		try {
			return await span(
				'db.query',
				attributes,
				async () => {
					const cancel = () => void query.cancel();
					signal.addEventListener('abort', cancel, { once: true });
					try {
						return await query;
					} catch (error) {
						if (signal.aborted) throw signal.reason;
						throw error;
					} finally {
						signal.removeEventListener('abort', cancel);
					}
				},
				{ signal },
			);
		} finally {
			const elapsedMs = performance.now() - began;
			this.#duration.record(elapsedMs / 1000, attributes);
			// Operation and duration only: parameters can hold personal data.
			if (elapsedMs > this.#options.slowQueryMs) {
				this.#log.warn({ operation, durationMs: Math.round(elapsedMs) }, 'slow query');
			}
		}
	}

	[Symbol.asyncDispose](): Promise<void> {
		this.#disposal ??= (async () => {
			await Promise.all([
				this.#sql.close({ timeout: this.#options.closeTimeoutS }),
				this.#control.close({ timeout: this.#options.closeTimeoutS }),
			]);
			this.#log.info('connection pool closed');
		})();
		return this.#disposal;
	}
}
