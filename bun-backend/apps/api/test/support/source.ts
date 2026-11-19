import { expect } from 'bun:test';
import { Glob } from 'bun';

/** Where the repository and the API app sit, whatever the cwd is. */
export const api = `${import.meta.dir}/../..`;
export const repo = `${api}/../..`;

// The rule files hold the very text their rules look for, so no scan reads them.
const RULE_FILES = new Set([
	'apps/api/test/structure.test.ts',
	'apps/api/test/duplicates.test.ts',
	'apps/api/test/support/source.ts',
]);

/**
 * Repo-relative paths of every .ts file under the given repo-relative globs. Each glob must find
 * at least one file: a rule over nothing passes whatever the code does, so a broken glob fails.
 */
export const scan = (...patterns: string[]) => {
	const out = new Set<string>();
	for (const p of patterns) {
		let found = 0;
		for (const f of new Glob(p).scanSync({ cwd: repo })) {
			const rel = f.replaceAll('\\', '/');
			if (!rel.includes('node_modules/') && !RULE_FILES.has(rel)) {
				out.add(rel);
				found++;
			}
		}
		expect(found, `"${p}" matched no files`).toBeGreaterThan(0);
	}
	return [...out].sort();
};

export const read = (f: string) => Bun.file(`${repo}/${f}`).text();

/**
 * The source with comments blanked and, unless `keepStrings`, string/template contents emptied,
 * newlines kept so line numbers hold. A small scanner, not a parser: it does not know regex
 * literals (a quote inside one can desync it) nor `${}` nesting inside a template (the whole
 * template is emptied or kept as one string).
 */
export const strip = (src: string, keepStrings = false) => {
	let out = '';
	let i = 0;
	while (i < src.length) {
		const ch = src[i]!;
		const next = src[i + 1];
		if (ch === '/' && next === '/') {
			while (i < src.length && src[i] !== '\n') i++;
		} else if (ch === '/' && next === '*') {
			const end = src.indexOf('*/', i + 2);
			const stop = end === -1 ? src.length : end + 2;
			out += src.slice(i, stop).replaceAll(/[^\n]/g, ' ');
			i = stop;
		} else if (ch === "'" || ch === '"' || ch === '`') {
			out += ch;
			i++;
			while (i < src.length && src[i] !== ch) {
				if (src[i] === '\\') {
					if (keepStrings) out += src[i]! + (src[i + 1] ?? '');
					i++;
				} else if (src[i] === '\n') out += '\n';
				else if (keepStrings) out += src[i];
				i++;
			}
			out += ch;
			i++;
		} else {
			out += ch;
			i++;
		}
	}
	return out;
};
