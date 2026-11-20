import { timestamp } from 'drizzle-orm/pg-core';

// Columns every table spells the same way. Times are UTC instants (timestamptz).

export const at = (name: string) => timestamp(name, { withTimezone: true });
export const createdAt = () => at('created_at').notNull().defaultNow();
export const updatedAt = () => at('updated_at').notNull().defaultNow();
