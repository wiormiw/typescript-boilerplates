import { sql } from 'drizzle-orm';
import type { AppError } from '@starter/lib/errors';
import { silentLogger } from '@starter/lib/log';
import type { Result } from '@starter/lib/result';
import { operationDuration } from './metrics.ts';
import { inTransaction } from './transaction.ts';
import type { AsUserOptions, SqlTarget, Tx } from './types.ts';

/**
 * Runs `work` in a transaction whose `app.user_id` is the caller's, which row-level security reads.
 * An abort cancels the running statement server-side (`pg_cancel_backend` sent on
 * `target.control`, since Drizzle queries take no signal) and rejects with the signal's reason; the
 * transaction rolls back. An abort between statements is caught after `work` returns, before the
 * commit. Removing the listener does not recall a cancel already sent: one that lands as the work
 * ends can still hit the commit, which then fails and surfaces as the abort.
 */
export async function asUser<R extends Result<unknown, AppError>>(
	target: SqlTarget,
	options: AsUserOptions,
	work: (tx: Tx) => Promise<R>,
): Promise<R> {
	const { userId, signal, operation } = options;
	signal.throwIfAborted();
	const log = (options.logger ?? silentLogger()).child({ component: 'db' });
	const began = performance.now();
	try {
		return await inTransaction(
			target.db,
			async (tx) => {
				// The pid comes back with the setting, so a cancel can name this backend.
				const rows = await tx.execute<{ pid: number }>(
					sql`select set_config('app.user_id', ${userId}, true), pg_backend_pid() as pid`,
				);
				const pid = rows[0]?.pid;
				if (pid !== undefined) options.onBackend?.(pid);
				signal.throwIfAborted();
				const cancel = () => {
					Promise.resolve(target.control.execute(sql`select pg_cancel_backend(${pid})`)).catch(
						(error: unknown) => log.debug({ err: error }, 'cancel request failed'),
					);
				};
				signal.addEventListener('abort', cancel, { once: true });
				try {
					const result = await work(tx);
					// An abort between statements finds the backend idle: nothing to cancel, so refuse
					// to commit instead.
					signal.throwIfAborted();
					return result;
				} finally {
					signal.removeEventListener('abort', cancel);
				}
			},
			{ 'starter.db.as_user': true, 'db.operation.name': operation },
			options.isolation,
		);
	} catch (error) {
		// The cancelled statement rejects with Postgres's 57014; the caller gave the real reason.
		if (signal.aborted) throw signal.reason;
		throw error;
	} finally {
		// Instruments are cheap to look up and the provider may be registered after import.
		operationDuration().record((performance.now() - began) / 1000, {
			'db.system.name': 'postgresql',
			'db.operation.name': operation,
		});
	}
}
