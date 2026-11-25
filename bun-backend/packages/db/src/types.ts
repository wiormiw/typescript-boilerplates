import type { ConnectionOptions } from '@starter/lib/lifecycle';
import type { Logger } from '@starter/lib/log';
import type { connect } from './client.ts';
import type { AUDIT_ACTIONS } from './schema/audit.ts';

/** `checkTimeoutMs` also bounds a readiness check queued behind a saturated pool. */
export interface DatabaseOptions extends ConnectionOptions {
	poolMax: number;
	idleTimeoutS: number;
	connectTimeoutS: number;
	/** How long disposal waits for in-flight queries before closing connections. */
	closeTimeoutS: number;
	/** A connection older than this is recycled, before infrastructure drops it silently. */
	maxLifetimeS: number;
	/** Queries slower than this are logged at warn, with operation and duration only. */
	slowQueryMs: number;
	/**
	 * Server-side limits, set on every connection. Postgres cancels the statement and frees the
	 * connection. Omitted for scripts, which may legitimately run long.
	 */
	/** Shown in `pg_stat_activity`, so one process's backends can be found. */
	applicationName?: string;
	limits?: {
		statementTimeoutMs: number;
		lockTimeoutMs: number;
		idleInTransactionTimeoutMs: number;
	};
}

export type Db = ReturnType<typeof connect>;

/** Drizzle's transaction handle. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The pool or an open transaction. */
export type Executor = Db | Tx;

export interface MigrateOptions {
	/** Connects as the database owner; the only connection allowed to run DDL. */
	ownerUrl: string;
	/** The API's login: user and password become a role in `starter_app`. */
	appUrl: string;
	migrationsFolder: string;
	connectTimeoutS: number;
	logger: Logger;
	signal: AbortSignal;
}

/** The transaction isolation levels Postgres offers; `asUser` defaults to the server's. */
export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export interface AsUserOptions {
	/** Becomes `app.user_id` for the transaction. */
	userId: string;
	/** An abort cancels the running statement server-side and rejects with the signal's reason. */
	signal: AbortSignal;
	/** Names the operation for spans and metrics. */
	operation: string;
	/** One snapshot for every statement when a read must agree with itself; default is read committed. */
	isolation?: IsolationLevel;
	/** Told the backend's pid once the transaction has one, so a caller can cancel it from afar. */
	onBackend?: (pid: number) => void;
	/** Where a failed cancel request is logged, at debug. */
	logger?: Logger;
}

/** Where `asUser` runs and where it sends a cancel from. */
export interface SqlTarget {
	/** The pool, or a transaction (a test's `withRollback`), the work runs on. */
	db: Executor;
	/** A pool other than `db`'s connection, so a cancel is never queued behind the statement. */
	control: Db;
}

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
	userId: string;
	action: AuditAction;
	ip?: string | undefined;
	userAgent?: string | undefined;
}
