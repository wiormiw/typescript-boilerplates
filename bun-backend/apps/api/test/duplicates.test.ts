import { describe, expect, test } from 'bun:test';
import { read, scan, strip } from './support/source.ts';

// Text heuristics, like the rules in structure.test.ts: they read comment-free source and cannot
// see through aliases, intersections (`A & { … }`) or object types nested inside a member. What
// they catch is the common slip, a definition written out a second time.

const SOURCES = ['apps/api/src/**/*.ts', 'packages/*/src/**/*.ts'];
const NOT_CONTRACTS = (f: string) => !f.startsWith('packages/contracts/');

interface Declaration {
	name: string;
	/** Each top-level member as written, whitespace collapsed: `logger: Logger`. */
	members: string[];
}

interface SchemaKeys {
	name: string;
	keys: string[];
}

/** Index of the `}` that closes the `{` at `open`, or -1. */
const closeBrace = (code: string, open: number) => {
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		if (code[i] === '{') depth++;
		else if (code[i] === '}' && --depth === 0) return i;
	}
	return -1;
};

/**
 * The members of an object body: split on `;` and `,` outside any bracket. `<`/`>` count as
 * brackets (a `Record<string, boolean>` holds a comma) except the `>` of an arrow `=>`.
 */
const splitMembers = (body: string) => {
	const out: string[] = [];
	let depth = 0;
	let from = 0;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i]!;
		if ('{[(<'.includes(ch)) depth++;
		else if ('}])'.includes(ch) || (ch === '>' && body[i - 1] !== '=')) depth--;
		else if ((ch === ';' || ch === ',') && depth === 0) {
			out.push(body.slice(from, i));
			from = i + 1;
		}
	}
	out.push(body.slice(from));
	return out.map((m) => m.replaceAll(/\s+/g, ' ').trim()).filter(Boolean);
};

const memberName = (member: string) => /^(?:readonly\s+)?([\w$]+)\??\s*[:(]/.exec(member)?.[1];

const DECLARATION =
	/(?:^|[\s;{}])(?:export\s+)?(?:declare\s+)?(?:interface\s+([\w$]+)[^{;=]*|type\s+([\w$]+)(?:<[^=;]*>)?\s*=\s*)\{/g;

/** Every `interface X {…}` and `type X = {…}`, exported or not. */
const declarations = (src: string): Declaration[] => {
	const code = strip(src, true);
	const found: Declaration[] = [];
	for (const m of code.matchAll(DECLARATION)) {
		const open = m.index! + m[0].length - 1;
		const close = closeBrace(code, open);
		if (close === -1) continue;
		found.push({ name: (m[1] ?? m[2])!, members: splitMembers(code.slice(open + 1, close)) });
	}
	return found;
};

const SCHEMA = /\bexport\s+const\s+([\w$]+)\s*=\s*v\.(?:object|strictObject|looseObject)\(\s*\{/g;

/** Every exported valibot object schema and its keys. */
const schemas = (src: string): SchemaKeys[] => {
	const code = strip(src, true);
	const found: SchemaKeys[] = [];
	for (const m of code.matchAll(SCHEMA)) {
		const open = m.index! + m[0].length - 1;
		const close = closeBrace(code, open);
		if (close === -1) continue;
		const keys = splitMembers(code.slice(open + 1, close)).flatMap((k) => memberName(k) ?? []);
		found.push({ name: m[1]!, keys });
	}
	return found;
};

/** A declaration that writes out (most of) a contract schema's keys again. */
const repeatsSchema = (decl: Declaration, schema: SchemaKeys) => {
	const names = decl.members.flatMap((m) => memberName(m) ?? []);
	const shared = names.filter((n) => schema.keys.includes(n)).length;
	return shared >= 3 && shared / Math.min(names.length, schema.keys.length) >= 0.75;
};

const sharedMembers = (a: Declaration, b: Declaration) =>
	a.members.filter((m) => b.members.includes(m));

/**
 * Sets of two or more string values written out as a union (`'a' | 'b'`), an `as const` tuple, or
 * a `picklist([…])` / `oneOfEnv([…])`, each as its sorted values. The same set written twice means
 * one of them should be derived from the other.
 */
const valueSets = (src: string) => {
	const code = strip(src, true);
	const found: string[][] = [];
	const add = (text: string) => {
		const values = [...text.matchAll(/'([^'\n]*)'/g)].map((m) => m[1]!);
		if (values.length >= 2) found.push([...new Set(values)].sort());
	};
	for (const m of code.matchAll(/(?:'[^'\n]*'\s*\|\s*)+'[^'\n]*'/g)) add(m[0]);
	for (const m of code.matchAll(/\[\s*(?:'[^'\n]*'\s*,?\s*)+\]\s*as const/g)) add(m[0]);
	for (const m of code.matchAll(/\b(?:picklist|oneOfEnv)\(\s*\[([^\]]*)\]/g)) add(m[1]!);
	return found;
};

const decl = (src: string) => declarations(src)[0]!;

describe('duplicates', () => {
	test('the declaration reader splits members the way TypeScript does', () => {
		expect(declarations('export interface A { a: string; b?: number }')).toEqual([
			{ name: 'A', members: ['a: string', 'b?: number'] },
		]);
		// Commas inside generics, arrows and nested objects do not split a member.
		expect(
			decl(
				[
					'export interface B extends C<D> {',
					'  flags: Record<string, boolean>;',
					'  on?: (a: string, b: number) => void;',
					'  nested: { x: 1; y: 2 };',
					'  method(a: string): Promise<void>',
					'}',
				].join('\n'),
			).members,
		).toEqual([
			'flags: Record<string, boolean>',
			'on?: (a: string, b: number) => void',
			'nested: { x: 1; y: 2 }',
			'method(a: string): Promise<void>',
		]);
		expect(decl('type T = { a: 1 };').name).toBe('T');
		expect(decl('export type G<X extends string> = { a: X };').name).toBe('G');
		expect(
			declarations('type U = string;\nconst o = { type: 1 };\n// interface K { a: 1 }'),
		).toEqual([]);
		expect(memberName('readonly a?: string')).toBe('a');
		expect(memberName('method(a: string): void')).toBe('method');
		expect(memberName('...spread')).toBeUndefined();
	});

	test('the value-set reader finds unions, tuples and picklists and ignores look-alikes', () => {
		expect(valueSets("type A = 'b' | 'a';")).toEqual([['a', 'b']]);
		expect(valueSets("type A =\n\t| 'x'\n\t| 'y'\n\t| 'z';")).toEqual([['x', 'y', 'z']]);
		expect(valueSets("const L = ['p', 'q'] as const;")).toEqual([['p', 'q']]);
		expect(valueSets("v.picklist(['m', 'n'], 'msg')")).toEqual([['m', 'n']]);
		expect(valueSets("oneOfEnv(['a', 'b', 'c'], 'a')")).toEqual([['a', 'b', 'c']]);
		expect(
			valueSets(
				[
					"type One = 'only';",
					"const same = x === 'a' || x === 'b';",
					"// type C = 'a' | 'b';",
					'const t = (typeof L)[number];',
					"const list = ['a', 'b'];",
				].join('\n'),
			),
		).toEqual([]);
	});

	test('a declaration that repeats a schema is told from one that merely overlaps', () => {
		const schema: SchemaKeys = {
			name: 'PView',
			keys: ['type', 'title', 'status', 'detail', 'code'],
		};
		const copy = decl(
			'interface P { type: string; title: string; status: number; detail: string; extra?: 1 }',
		);
		expect(repeatsSchema(copy, schema)).toBe(true);
		expect(repeatsSchema(decl('interface Q { type: string; status: number }'), schema)).toBe(false);
		expect(
			repeatsSchema(
				decl('interface R { a: 1; b: 2; c: 3; d: 4; e: 5; type: 1; title: 1 }'),
				schema,
			),
		).toBe(false);
		const found = schemas(
			'export const V = v.object({ a: v.string(), b: v.pipe(v.number(), v.minValue(0)), c: v.optional(v.record(v.string(), v.unknown())) });\nconst Local = v.object({ z: 1 });',
		);
		expect(found).toEqual([{ name: 'V', keys: ['a', 'b', 'c'] }]);
	});

	test('two declarations with three identical members are told from two that share fewer', () => {
		const a = decl('interface A { lifecycle: Lifecycle; logger: Logger; budgetMs: number; x: 1 }');
		const b = decl('interface B { budgetMs: number; lifecycle: Lifecycle; logger: Logger; y: 2 }');
		const c = decl('interface C { logger: Logger; budgetMs: number; z: 3 }');
		expect(sharedMembers(a, b)).toEqual([
			'lifecycle: Lifecycle',
			'logger: Logger',
			'budgetMs: number',
		]);
		expect(sharedMembers(a, c)).toHaveLength(2);
		// Same name, different type: not the same member.
		expect(
			sharedMembers(decl('interface D { a: string }'), decl('interface E { a: number }')),
		).toEqual([]);
	});

	test('a set of values is written once', async () => {
		const sites = new Map<string, string[]>();
		for (const f of scan(...SOURCES)) {
			for (const values of valueSets(await read(f))) {
				const key = values.join(', ');
				sites.set(key, [...(sites.get(key) ?? []), f]);
			}
		}
		const twice = [...sites].filter(([, files]) => files.length > 1);
		expect(twice.map(([values, files]) => `{${values}} in ${files.join(', ')}`)).toEqual([]);
	});

	test('a wire shape is not written out again outside contracts', async () => {
		const wire: SchemaKeys[] = [];
		for (const f of scan('packages/contracts/src/**/*.ts')) wire.push(...schemas(await read(f)));
		expect(wire.length).toBeGreaterThan(0);
		const bad: string[] = [];
		for (const f of scan(...SOURCES).filter(NOT_CONTRACTS)) {
			for (const d of declarations(await read(f))) {
				for (const s of wire) {
					if (repeatsSchema(d, s))
						bad.push(`${f}: ${d.name} repeats ${s.name}, use its inferred type`);
				}
			}
		}
		expect(bad).toEqual([]);
	});

	test('no two declarations share three members', async () => {
		const all: { file: string; d: Declaration }[] = [];
		for (const f of scan(...SOURCES).filter(NOT_CONTRACTS)) {
			for (const d of declarations(await read(f))) all.push({ file: f, d });
		}
		const bad: string[] = [];
		for (let i = 0; i < all.length; i++) {
			for (let j = i + 1; j < all.length; j++) {
				const shared = sharedMembers(all[i]!.d, all[j]!.d);
				if (shared.length >= 3) {
					bad.push(
						`${all[i]!.d.name} (${all[i]!.file}) and ${all[j]!.d.name} (${all[j]!.file}) both declare ${shared.join('; ')}`,
					);
				}
			}
		}
		expect(bad).toEqual([]);
	});
});
