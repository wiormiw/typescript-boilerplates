/** A Postgres array literal, bound as one text parameter and cast in SQL (`::text[]`). */
// Drizzle on bun:sql expands a bound JS array into a parameter list, so array binds go here
// (pinned in test/bun-sql.traps.integration.test.ts).
export function pgArray(values: readonly (string | number)[]): string {
	const quoted = values.map(
		(value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
	);
	return `{${quoted.join(',')}}`;
}

/** An ILIKE pattern matching `text` anywhere, with its wildcards escaped. */
export const containing = (text: string): string => `%${text.replaceAll(/[\\%_]/g, '\\$&')}%`;

/** The row the SQL guarantees (scalar subqueries, a one-row RETURNING, an aggregate); any other count is a bug. */
export function one<T>(rows: readonly T[], what: string): T {
	const [row] = rows;
	if (rows.length !== 1 || row === undefined) {
		throw new Error(`expected one ${what}, got ${rows.length}`);
	}
	return row;
}

/** The row a lookup may or may not find; the caller turns `undefined` into its domain error. */
export function first<T>(rows: readonly T[]): T | undefined {
	const [row] = rows;
	return row;
}
