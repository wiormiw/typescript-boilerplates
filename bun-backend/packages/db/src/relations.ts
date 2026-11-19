import { defineRelations } from 'drizzle-orm';
import * as schema from './schema/index.ts';

// Relations the relational query API (`db.query.*`) follows. Modules add theirs as they need
// them; each `many` needs the `one` on the other side.
export const relations = defineRelations(schema, () => ({}));
