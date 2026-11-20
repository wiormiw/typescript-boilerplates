import { eq } from 'drizzle-orm';
import { audit } from './schema/audit.ts';
import type { AuditEntry, Tx } from './types.ts';

/** Appends one audit row. Runs on the caller's `asUser` transaction, so RLS checks the user. */
export async function recordAudit(tx: Tx, entry: AuditEntry): Promise<void> {
	await tx.insert(audit).values({
		id: Bun.randomUUIDv7(),
		userId: entry.userId,
		action: entry.action,
		ip: entry.ip ?? null,
		userAgent: entry.userAgent ?? null,
	});
}

/** Deletes every audit row of one user, for account deletion; the caller then records that fact. */
export async function eraseAudit(tx: Tx, userId: string): Promise<void> {
	await tx.delete(audit).where(eq(audit.userId, userId));
}
