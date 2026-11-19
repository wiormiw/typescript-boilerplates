import { expect, test } from 'bun:test';
import { ValidationFailed, Unauthenticated } from '@starter/lib/errors';
import { err, ok, type Result } from '@starter/lib/result';
import { assertTrue, type Equal } from '@starter/lib/testing';
import { type Executor, inTransaction } from '@starter/db';

test('a callback returning several error classes infers their union', () => {
	// Never called: only its type is checked, so no database is needed.
	const run = (db: Executor, pick: number) =>
		inTransaction(db, async () => {
			if (pick === 0) return err(new ValidationFailed());
			if (pick === 1) return err(new Unauthenticated());
			return ok(1);
		});
	assertTrue<
		Equal<Awaited<ReturnType<typeof run>>, Result<number, ValidationFailed | Unauthenticated>>
	>();
	expect(typeof run).toBe('function');
});
