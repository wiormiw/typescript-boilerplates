import type { Attributes } from '@opentelemetry/api';
import type { AppError } from '@starter/lib/errors';
import type { Result } from '@starter/lib/result';
import { traced } from '@starter/lib/tracing';
import type { Executor, Tx } from './client.ts';
import type { IsolationLevel } from './types.ts';

/** Carries a returned `err` out of Drizzle's callback; never leaves this file. */
class Rollback<R> extends Error {
	readonly result: R;
	constructor(result: R) {
		super('rolled back');
		this.result = result;
	}
}

/**
 * Runs `work` in one transaction: commits on `ok`, rolls back on `err` or a throw, so a failure
 * found halfway never commits the half already written, nor its events. Given a transaction, it
 * opens a savepoint, so a service called inside another's transaction (or a test's) still rolls
 * back only its own part.
 *
 * `isolation` applies to a top-level transaction only; a savepoint inherits its parent's.
 *
 * Generic over the whole result rather than its value and error: a callback returning several
 * error classes then infers their union, where inferring `E` alone would pick one of them.
 */
export function inTransaction<R extends Result<unknown, AppError>>(
	db: Executor,
	work: (tx: Tx) => Promise<R>,
	attributes: Attributes = {},
	isolation?: IsolationLevel,
): Promise<R> {
	return traced('db.transaction', { 'db.system.name': 'postgresql', ...attributes }, async () => {
		try {
			const body = async (tx: Tx) => {
				const result = await work(tx);
				// Drizzle rolls back only on a throw.
				if (!result.ok) throw new Rollback(result);
				return result;
			};
			return await (isolation === undefined
				? db.transaction(body)
				: db.transaction(body, { isolationLevel: isolation }));
		} catch (error) {
			if (error instanceof Rollback) return error.result as R;
			throw error;
		}
	});
}
