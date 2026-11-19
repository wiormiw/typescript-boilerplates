import type { Logger } from '@starter/lib/log';
import type { connect } from './client.ts';

export interface DatabaseOptions {
	url: string;
	poolMax: number;
	idleTimeoutS: number;
	connectTimeoutS: number;
	/** How long disposal waits for in-flight queries before closing connections. */
	closeTimeoutS: number;
	/** Queries slower than this are logged at warn, with operation and duration only. */
	slowQueryMs: number;
	/**
	 * Server-side limits, set on every connection. Postgres cancels the statement and frees the
	 * connection. Omitted for scripts, which may legitimately run long.
	 */
	limits?: {
		statementTimeoutMs: number;
		lockTimeoutMs: number;
		idleInTransactionTimeoutMs: number;
	};
	logger: Logger;
}

export type Db = ReturnType<typeof connect>;

/** Drizzle's transaction handle. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The pool or an open transaction. */
export type Executor = Db | Tx;
