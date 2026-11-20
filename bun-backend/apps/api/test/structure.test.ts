import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import { Glob } from 'bun';
import { api, read, repo, scan, strip } from './support/source.ts';

// scripts/ does not exist until a slice adds one; once it does, its glob must match like the rest.
const everywhere = () =>
	scan(
		'apps/api/src/**/*.ts',
		...(existsSync(`${api}/scripts`) ? ['apps/api/scripts/**/*.ts'] : []),
		'apps/api/test/**/*.ts',
		'packages/*/src/**/*.ts',
	);

// Static `from`, side-effect `import "x"` and dynamic `import("x")`, either quote style.
const specifiers = (src: string) =>
	[...src.matchAll(/(?:from\s+|import\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]!);

const importers = async (pattern: RegExp) => {
	const found: string[] = [];
	for (const f of everywhere()) {
		if (specifiers(await read(f)).some((s) => pattern.test(s))) found.push(f);
	}
	return found;
};

/**
 * TypeScript-only syntax left in comment- and string-free source: `enum`, `namespace`, the
 * `private`/`protected` modifiers and constructor parameter properties. A text heuristic: a
 * modifier counts only in member position (after whitespace or `;{}`, then an identifier and one of
 * `( : = ; ? < !`), so `#private`, a `private:` key and the word in prose do not. It cannot catch
 * a modifier on its own line from the member it modifies, nor anything behind a desynced strip()
 * (a quote inside a regex literal). tsc's erasableSyntaxOnly is the real gate for enum/namespace
 * and parameter properties; this rule keeps the text honest where tsc is not run.
 */
const tsOnly = (src: string) => {
	const code = strip(src);
	const rules: [string, RegExp][] = [
		['enum', /(?<![\w.#$])enum\s+[A-Za-z_$]/],
		['namespace', /(?<![\w.#$])namespace\s+[A-Za-z_$]/],
		[
			'private/protected modifier',
			/(?:^|[\s;{}])(?:private|protected)\s+(?:(?:static|readonly|async|abstract|override|declare)\s+)*[A-Za-z_$][\w$]*\s*[(:=;?<!]/m,
		],
		['parameter property', /constructor\(\s*(?:private|protected|public|readonly)\b/],
	];
	return rules.filter(([, re]) => re.test(code)).map(([name]) => name);
};

/**
 * The repo-relative path a specifier points at, alias or relative, or undefined for a package.
 * `importer` is repo-relative too. No extension is added: a specifier into a folder stays a folder.
 */
const resolveSpec = (importer: string, spec: string) => {
	if (spec.startsWith('#src/')) return `apps/api/src/${spec.slice('#src/'.length)}`;
	if (spec.startsWith('./') || spec.startsWith('../')) {
		return posix.normalize(posix.join(posix.dirname(importer), spec));
	}
	return undefined;
};

const MODULE_PATH = /^apps\/api\/(src|test)\/modules\/([^/]+)(?:\/(.*))?$/;
const KEBAB_TS = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.ts$/;

/** Why a file under apps/api/src/modules does not fit the module shape, or undefined if it does. */
const moduleLayoutViolation = (path: string) => {
	const m = /^apps\/api\/src\/modules\/(.+)$/.exec(path);
	if (!m) return undefined;
	const parts = m[1]!.split('/');
	const [name, ...rest] = parts;
	if (rest.length === 0) return 'a file directly under modules/, which holds module folders only';
	const roleFiles = new Set([`${name}.module.ts`, `${name}.types.ts`]);
	const sub: Record<string, (file: string) => boolean> = {
		router: (f) => f === `${name}.router.ts`,
		'use-cases': (f) => KEBAB_TS.test(f),
		repository: (f) => f === `${name}.repository.ts`,
		consumers: (f) => f === `${name}.consumer.ts`,
	};
	if (rest.length === 1) return roleFiles.has(rest[0]!) ? undefined : 'not a module role file';
	const [dir, file, ...deeper] = rest;
	const ok = sub[dir!];
	if (!ok) return `"${dir}/" is not a module subfolder`;
	if (deeper.length > 0) return `nested below ${dir}/`;
	return ok(file!) ? undefined : `not an allowed file name in ${dir}/`;
};

/** Specifiers in `src` that land in a module other than the importer's own (`own`). */
const crossModuleImports = (file: string, src: string, own: string | undefined) =>
	specifiers(src).filter((s) => {
		const hit = MODULE_PATH.exec(resolveSpec(file, s) ?? '');
		return hit !== null && hit[2] !== own;
	});

/** Specifiers in `src` that land anywhere under apps/api/src/modules. */
const moduleImports = (file: string, src: string) =>
	specifiers(src).filter((s) => /^apps\/api\/src\/modules(\/|$)/.test(resolveSpec(file, s) ?? ''));

/** Specifiers in `src` that land in a module's repository folder. */
const repositoryImports = (file: string, src: string) =>
	specifiers(src).filter((s) =>
		/^apps\/api\/src\/modules\/[^/]+\/repository(\/|$)/.test(resolveSpec(file, s) ?? ''),
	);

/**
 * A response built by hand instead of through `reply`/`respond`, in comment- and string-free code:
 * any `x.json(`, `.text(`, `.html(`, `.body(` or `.newResponse(` call, or `new Response(`. Reading
 * a request (`c.req.json(`, `req.text(`) is not building a response.
 */
const rawResponse = (src: string) => {
	const code = strip(src).replaceAll(
		/\b(?:req|request|response|res)\.(?:json|text|body|arrayBuffer)\(/g,
		'read(',
	);
	return /(?:\)|\w)\??\.(?:json|text|html|body|newResponse)\(|new Response\(/.test(code);
};

/** Code that starts the process (`Bun.serve`, spaced or generic) or installs its signal handlers. */
const mainOnly = (src: string) => /\bBun\s*\.\s*serve\b|\bhandleSignals\b/.test(strip(src));

/**
 * Declarations that belong in a types file: `export interface`, `export type X =`, `export declare`.
 * A class-companion type (`export type X = InstanceType<typeof X>`, `v.InferOutput<typeof X>`)
 * names the type of a value of the same name declared beside it, so it stays with that value.
 */
const exportedTypeDecls = (src: string) =>
	[
		...strip(src).matchAll(
			/(?:^|[\s;{}])export\s+(?:declare\s+\w+\s+[\w$]+|interface\s+[\w$]+|type\s+([\w$]+)(?![\w$])(?!\s*=\s*(?:InstanceType|v\.InferOutput)<typeof\s+\1\s*>))/g,
		),
	].map((m) => m[0].trim());

const isTypesFile = (f: string) => /(?:^|\/)(?:[\w-]+\.)?types\.ts$/.test(f);

/** Specifiers in `src` that land under one of the given apps/api/src folders. */
const importsUnder = (file: string, src: string, folders: string[]) =>
	specifiers(src).filter((s) => {
		const to = resolveSpec(file, s) ?? '';
		return folders.some((d) => to === `apps/api/src/${d}` || to.startsWith(`apps/api/src/${d}/`));
	});

/** Index just past the `>` that closes the `<` at `open`, or `open` if it does not close. */
const skipAngle = (code: string, open: number) => {
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		if (code[i] === '<') depth++;
		else if (code[i] === '>' && code[i - 1] !== '=') {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return open;
};

type Frame = '(' | '<' | 'filter' | '[' | 'pat' | 'bpat' | 'val';

/**
 * Scans a parameter list (`mode` 'params', `at` is its `(`) or a return type (`mode` 'return', `at`
 * is just after the `:`) and says whether it holds an object type literal, plus where it ended.
 * A `{` is a literal unless it is a destructuring pattern (right after `(` or `,` of the parameter
 * list, or nested in one) or a default value (after `=`). Brackets are tracked on a stack so a
 * pattern's inner `{` after `:` (a rename) is not mistaken for a type.
 */
const scanSignature = (code: string, at: number, mode: 'params' | 'return') => {
	const stack: Frame[] = [];
	let prev = mode === 'return' ? ':' : '';
	const top = () => stack[stack.length - 1];
	const patternSlot = () => {
		const t = top();
		if (t === '(') return prev === '(' || prev === ',';
		if (t === 'pat') return prev === '{' || prev === ',' || prev === ':';
		if (t === 'bpat') return prev === '[' || prev === ',';
		return false;
	};
	for (let i = at; i < code.length; i++) {
		const ch = code[i]!;
		if (/\s/.test(ch)) continue;
		if (ch === '=' && code[i + 1] === '>') {
			if (mode === 'return' && stack.length === 0) return { literal: false, end: i };
			prev = '>';
			i++;
			continue;
		}
		if (top() === 'val' && ch !== '{' && ch !== '}' && ch !== '(' && ch !== ')') {
			prev = ch;
			continue;
		}
		if (ch === '{') {
			if (top() === 'val' || top() === 'filter' || prev === '=') stack.push('val');
			else if (patternSlot()) stack.push('pat');
			else if (mode === 'return' && stack.length === 0 && !':|&'.includes(prev)) {
				return { literal: false, end: i }; // the function body
			} else return { literal: true, end: i };
		} else if (ch === '}') {
			while (stack.length && top() !== 'pat' && top() !== 'val') stack.pop();
			stack.pop();
		} else if (ch === '(') {
			stack.push(top() === 'val' ? 'val' : '(');
		} else if (ch === ')') {
			while (stack.length && top() !== '(' && top() !== 'val') stack.pop();
			stack.pop();
			if (stack.length === 0) return { literal: false, end: i + 1 };
		} else if (ch === '[') {
			stack.push(patternSlot() ? 'bpat' : '[');
		} else if (ch === ']') {
			while (stack.length && top() !== '[' && top() !== 'bpat') stack.pop();
			stack.pop();
		} else if (ch === '<') {
			// Extract/Exclude take a filter pattern (`Extract<R, { ok: true }>`), not a data shape.
			stack.push(
				/\b(?:Extract|Exclude)\s*$/.test(code.slice(Math.max(0, i - 12), i)) ? 'filter' : '<',
			);
		} else if (ch === '>') {
			if (top() === '<' || top() === 'filter') stack.pop();
		} else if (ch === ';' && stack.length === 0) {
			return { literal: false, end: i };
		}
		prev = ch;
	}
	return { literal: false, end: code.length };
};

/** The names of exported functions and public methods whose parameters or return type use an object literal. */
const inlineSignatureTypes = (src: string) => {
	const code = strip(src);
	const found: string[] = [];
	const check = (name: string, paren: number) => {
		const params = scanSignature(code, paren, 'params');
		let literal = params.literal;
		if (!literal) {
			let j = params.end;
			while (/\s/.test(code[j] ?? '')) j++;
			if (code[j] === ':') literal = scanSignature(code, j + 1, 'return').literal;
		}
		if (literal) found.push(name);
	};
	const isCall = (close: number) => /^\s*(?:=>|:|\{)/.test(code.slice(close, close + 12));
	for (const m of code.matchAll(
		/\bexport\s+(?:default\s+)?(?:async\s+)?function\b\s*\*?\s*([\w$]*)\s*/g,
	)) {
		let i = m.index! + m[0].length;
		if (code[i] === '<') i = skipAngle(code, i);
		while (/\s/.test(code[i] ?? '')) i++;
		if (code[i] === '(') check(m[1] || 'default', i);
	}
	for (const m of code.matchAll(
		/\bexport\s+const\s+([\w$]+)\s*=\s*(?:async\s+)?(?:function\b\s*\*?\s*[\w$]*\s*)?/g,
	)) {
		let i = m.index! + m[0].length;
		if (code[i] === '<') i = skipAngle(code, i);
		while (/\s/.test(code[i] ?? '')) i++;
		if (code[i] === '(' && isCall(scanSignature(code, i, 'params').end)) check(m[1]!, i);
	}
	// Public methods: members at brace depth 1 of an exported class body (`#x` and fields skipped).
	for (const m of code.matchAll(/\bexport\s+(?:default\s+)?(?:abstract\s+)?class\b[^{]*\{/g)) {
		const className = /class\s+([\w$]+)/.exec(m[0])?.[1] ?? 'default';
		let depth = 0;
		let prev = '{';
		for (let i = m.index! + m[0].length - 1; i < code.length; i++) {
			const ch = code[i]!;
			if (ch === '{') depth++;
			else if (ch === '}') {
				depth--;
				if (depth === 0) break;
			}
			if (depth === 1 && '{};'.includes(prev) && /[A-Za-z_$*]/.test(ch)) {
				const mem =
					/^(?:(?:public|static|async|override|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*/.exec(
						code.slice(i),
					);
				if (mem) {
					let k = i + mem[0].length;
					if (code[k] === '<') k = skipAngle(code, k);
					while (/\s/.test(code[k] ?? '')) k++;
					if (code[k] === '(') check(`${className}.${mem[1]}`, k);
				}
			}
			if (!/\s/.test(ch)) prev = ch;
		}
	}
	return found;
};

/** `v.object(` and its relatives in comment- and string-free code. */
const objectSchema = (src: string) =>
	/\bv\.(?:object|strictObject|looseObject|objectWithRest)\(/.test(strip(src));

/**
 * Names a repository file imports that open their own connection or transaction: `Db`,
 * `BunSqlDatabase`, `asUser`. A repository gets the `Tx` a use case opened with `asUser`, so row-level
 * security is always in force. A text heuristic over import clauses (with `type` and `as` forms); a
 * namespace import (`import * as db`) or a re-export through another file is not seen.
 */
const connectionImports = (src: string) => {
	const found: string[] = [];
	for (const m of strip(src).matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from/g)) {
		for (const part of m[1]!.split(',')) {
			const name = part
				.trim()
				.replace(/^type\s+/, '')
				.split(/\s+as\s+/)[0]!;
			if (['Db', 'BunSqlDatabase', 'asUser'].includes(name)) found.push(name);
		}
	}
	return found;
};

// No module has a repository yet, and scan() fails on a glob that matches nothing, so this one
// returns an empty list until the first one lands; the self-tests carry the proof until then.
const repositoryFiles = () =>
	[...new Glob('apps/api/src/modules/*/repository/**/*.ts').scanSync({ cwd: repo })].sort();

const OWNED_TABLES = ['userSettings', 'audit'];

/**
 * Exported repository functions whose body names an owned table but not `userId`. Row-level security
 * would hide other users' rows anyway; this keeps the query honest about whose rows it means. A text
 * heuristic: a function is the text from one top-level `export` to the next, a table is a whole-word
 * match, and `userId` anywhere in that text (a parameter, a column, a comment-free mention) satisfies
 * it, so it cannot tell a real filter from a stray mention.
 */
const unscopedOwnedQueries = (src: string) => {
	const code = strip(src);
	const starts = [...code.matchAll(/^export\s/gm)].map((m) => m.index!);
	const found: string[] = [];
	starts.forEach((start, i) => {
		const text = code.slice(start, starts[i + 1] ?? code.length);
		const name = /^export\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+)([\w$]+)/.exec(text)?.[1];
		if (
			!name ||
			!/^export\s+(?:async\s+)?function\b|=\s*(?:async\s*)?(?:\(|function\b)/.test(text)
		) {
			return;
		}
		const names = OWNED_TABLES.some((t) => new RegExp(`(?<![\\w$.])${t}(?![\\w$])`).test(text));
		if (names && !/\buserId\b/.test(text)) found.push(name);
	});
	return found;
};

describe('structure', () => {
	test('a glob that matches nothing fails the rule instead of passing it', () => {
		expect(() => scan('apps/api/src/no-such-dir/**/*.ts')).toThrow('matched no files');
		expect(scan('apps/api/src/*.ts').length).toBeGreaterThan(0);
	});

	test('only container.ts imports @inferdi/inferdi', async () => {
		expect(await importers(/^@inferdi\/inferdi(\/|$)/)).toEqual([
			'apps/api/src/bootstrap/container.ts',
		]);
	});

	test('only main.ts calls Bun.serve or handleSignals', async () => {
		const starting: string[] = [];
		// lifecycle.ts defines handleSignals; main.ts is the one place that calls it. Tests that need
		// a real socket go through test/support/serve.ts, the one test-side server.
		const allowed = new Set([
			'apps/api/src/main.ts',
			'packages/lib/src/lifecycle.ts',
			'apps/api/test/support/serve.ts',
		]);
		for (const f of everywhere()) {
			if (allowed.has(f)) continue;
			if (mainOnly(await read(f))) starting.push(f);
		}
		expect(starting).toEqual([]);
	});

	// packages/jobs gets the exception in slice B6 (its glob is added there); until then nothing may
	// import ioredis.
	test('ioredis is imported only under packages/jobs', async () => {
		expect(await importers(/^ioredis(\/|$)/)).toEqual([]);
	});

	test('the TypeScript-only syntax detector catches each form and ignores look-alikes', () => {
		expect(tsOnly('enum X {}')).toEqual(['enum']);
		expect(tsOnly('declare namespace N {}')).toEqual(['namespace']);
		expect(tsOnly('class A {\n\tprivate x = 1;\n}')).toEqual(['private/protected modifier']);
		expect(tsOnly('class A { protected static readonly y: number }')).toEqual([
			'private/protected modifier',
		]);
		expect(tsOnly('class A { private async run() {} }')).toEqual(['private/protected modifier']);
		expect(tsOnly('class A { constructor(private x: X) {} }')).toEqual(['parameter property']);
		expect(tsOnly('class A { constructor(readonly x: X) {} }')).toEqual(['parameter property']);
		expect(
			tsOnly(
				[
					'// private enum Foo {}',
					"const s = 'enum X {} private y = 1';",
					'const t = `namespace N {}`;',
					'/* protected z: number */',
					'class A { #private = 1; #enumerate() {} }',
					'const o = { private: true, enumerable: 1 };',
					'export const namespaced = 1;',
				].join('\n'),
			),
		).toEqual([]);
	});

	test('no TypeScript-only syntax', async () => {
		const found: string[] = [];
		for (const f of everywhere()) {
			for (const what of tsOnly(await read(f))) found.push(`${f}: ${what}`);
		}
		expect(found).toEqual([]);
	});

	// Inside apps/api/src a file reaches its own tree through `#src/...`, never `../`.
	test('no relative ../ imports inside apps/api/src', async () => {
		const up: string[] = [];
		for (const f of scan('apps/api/src/**/*.ts')) {
			for (const s of specifiers(await read(f))) if (s.startsWith('../')) up.push(`${f} -> ${s}`);
		}
		expect(up).toEqual([]);
	});

	// scripts/ is scanned when it exists; its rules join in the slice that adds the folder.

	// A module is a directory under modules/ holding <m>.module.ts, <m>.types.ts and the subfolders
	// router/, use-cases/, repository/ and consumers/, each with the files its role allows.
	test('the module layout detector flags each stray file and accepts the shape', () => {
		const m = 'apps/api/src/modules/health';
		expect(moduleLayoutViolation(`${m}/health.module.ts`)).toBeUndefined();
		expect(moduleLayoutViolation(`${m}/health.types.ts`)).toBeUndefined();
		expect(moduleLayoutViolation(`${m}/router/health.router.ts`)).toBeUndefined();
		expect(moduleLayoutViolation(`${m}/use-cases/check-readiness.ts`)).toBeUndefined();
		expect(moduleLayoutViolation(`${m}/repository/health.repository.ts`)).toBeUndefined();
		expect(moduleLayoutViolation(`${m}/consumers/health.consumer.ts`)).toBeUndefined();
		expect(moduleLayoutViolation(`${m}/health.service.ts`)).toBeDefined();
		expect(moduleLayoutViolation(`${m}/billing.module.ts`)).toBeDefined();
		expect(moduleLayoutViolation(`${m}/router/extra.ts`)).toBeDefined();
		expect(moduleLayoutViolation(`${m}/use-cases/CheckReadiness.ts`)).toBeDefined();
		expect(moduleLayoutViolation(`${m}/use-cases/deep/check.ts`)).toBeDefined();
		expect(moduleLayoutViolation(`${m}/repository/queries.ts`)).toBeDefined();
		expect(moduleLayoutViolation(`${m}/consumers/health.router.ts`)).toBeDefined();
		expect(moduleLayoutViolation(`${m}/helpers/x.ts`)).toBeDefined();
		expect(moduleLayoutViolation('apps/api/src/modules/stray.ts')).toBeDefined();
	});

	test('a module folder holds role files only', () => {
		const stray: string[] = [];
		for (const f of scan('apps/api/src/modules/**/*.ts')) {
			const why = moduleLayoutViolation(f);
			if (why) stray.push(`${f}: ${why}`);
		}
		expect(stray).toEqual([]);
	});

	test('the cross-module detector catches alias and relative imports into another module', () => {
		const from = 'apps/api/src/modules/health/router/health.router.ts';
		const hit = (src: string, file = from, own = 'health') => crossModuleImports(file, src, own);
		expect(hit("import { x } from '#src/modules/goals/goals.module.ts';")).toHaveLength(1);
		expect(hit("import { x } from '../../goals/goals.types.ts';")).toHaveLength(1);
		expect(hit("export * from '#src/modules/goals/use-cases/a.ts';")).toHaveLength(1);
		expect(hit("const m = await import('#src/modules/goals/goals.module.ts');")).toHaveLength(1);
		expect(hit("import { x } from '../../../../test/modules/goals/a.ts';", from)).toHaveLength(1);
		expect(hit("import { x } from '#src/modules/health/health.types.ts';")).toEqual([]);
		expect(hit("import { x } from '../health.types.ts';")).toEqual([]);
		expect(hit("import { x } from '#src/bootstrap/types.ts';")).toEqual([]);
		expect(hit("import { x } from 'hono';")).toEqual([]);
	});

	test('modules never import each other', async () => {
		const crossing: string[] = [];
		for (const f of scan('apps/api/src/modules/*/**/*.ts', 'apps/api/test/modules/*/**/*.ts')) {
			const own = MODULE_PATH.exec(f)?.[2];
			for (const s of crossModuleImports(f, await read(f), own)) crossing.push(`${f} -> ${s}`);
		}
		expect(crossing).toEqual([]);
	});

	test('the modules-import detector catches alias and relative imports of a module', () => {
		const from = 'apps/api/src/middleware/security.ts';
		expect(
			moduleImports(from, "import { x } from '#src/modules/health/health.module.ts';"),
		).toHaveLength(1);
		expect(
			moduleImports(from, "import { x } from '../modules/health/health.module.ts';"),
		).toHaveLength(1);
		expect(moduleImports(from, "import { x } from '#src/bootstrap/types.ts';")).toEqual([]);
		expect(moduleImports(from, "import { x } from 'hono';")).toEqual([]);
	});

	test('only src/bootstrap imports from src/modules', async () => {
		const outside: string[] = [];
		for (const f of scan('apps/api/src/**/*.ts')) {
			if (f.startsWith('apps/api/src/bootstrap/') || f.startsWith('apps/api/src/modules/'))
				continue;
			for (const s of moduleImports(f, await read(f))) outside.push(`${f} -> ${s}`);
		}
		expect(outside).toEqual([]);
	});

	test('the router detector catches a repository import, alias or relative', () => {
		const from = 'apps/api/src/modules/health/router/health.router.ts';
		expect(
			repositoryImports(
				from,
				"import { r } from '#src/modules/health/repository/health.repository.ts';",
			),
		).toHaveLength(1);
		expect(
			repositoryImports(from, "import { r } from '../repository/health.repository.ts';"),
		).toHaveLength(1);
		expect(
			repositoryImports(
				from,
				"import { c } from '#src/modules/health/use-cases/check-readiness.ts';",
			),
		).toEqual([]);
		expect(
			repositoryImports(from, "import { c } from '#src/modules/health/health.types.ts';"),
		).toEqual([]);
	});

	test('routers never import a repository directly', async () => {
		const bad: string[] = [];
		for (const f of scan('apps/api/src/modules/*/router/**/*.ts')) {
			for (const s of repositoryImports(f, await read(f))) bad.push(`${f} -> ${s}`);
		}
		expect(bad).toEqual([]);
	});

	test('the connection-import detector flags Db, BunSqlDatabase and asUser in each import form', () => {
		const from = '@starter/db';
		expect(connectionImports(`import { Db } from '${from}';`)).toEqual(['Db']);
		expect(connectionImports(`import type { Db, Tx } from '${from}';`)).toEqual(['Db']);
		expect(connectionImports(`import { type Db as Pool } from '${from}';`)).toEqual(['Db']);
		expect(connectionImports(`import { Tx, asUser } from '${from}';`)).toEqual(['asUser']);
		expect(connectionImports(`import {\n\tBunSqlDatabase,\n\taudit,\n} from '${from}';`)).toEqual([
			'BunSqlDatabase',
		]);
		expect(connectionImports(`import type { Tx } from '${from}';`)).toEqual([]);
		expect(connectionImports(`import { audit, userSettings } from '${from}';`)).toEqual([]);
		expect(
			connectionImports(`// import { Db } from 'x';\nconst s = "import { asUser } from 'x'";`),
		).toEqual([]);
	});

	test('repositories take a Tx and never open a connection or transaction', async () => {
		const bad: string[] = [];
		for (const f of repositoryFiles()) {
			for (const name of connectionImports(await read(f))) bad.push(`${f}: ${name}`);
		}
		expect(bad).toEqual([]);
	});

	test('the owned-table detector flags a function that names a table without userId', () => {
		const hit = (src: string) => unscopedOwnedQueries(src);
		expect(hit('export async function read(tx: Tx) { return tx.select().from(audit); }')).toEqual([
			'read',
		]);
		expect(hit('export const load = async (tx: Tx) => tx.select().from(userSettings);')).toEqual([
			'load',
		]);
		expect(
			hit(
				[
					'export async function ok(tx: Tx, userId: string) {',
					'\treturn tx.select().from(audit).where(eq(audit.userId, userId));',
					'}',
					'export async function bad(tx: Tx) { return tx.delete(userSettings); }',
				].join('\n'),
			),
		).toEqual(['bad']);
		expect(
			hit('export async function ok(tx: Tx, userId: string) { return tx.insert(audit); }'),
		).toEqual([]);
		expect(hit('export async function other(tx: Tx) { return tx.select().from(goals); }')).toEqual(
			[],
		);
		expect(hit('export async function w(tx: Tx) { return tx.select().from(auditLog); }')).toEqual(
			[],
		);
		expect(hit('// export function x() { audit }\nexport const A = 1;')).toEqual([]);
	});

	test('repository functions that name an owned table also name userId', async () => {
		const bad: string[] = [];
		for (const f of repositoryFiles()) {
			for (const name of unscopedOwnedQueries(await read(f))) bad.push(`${f}: ${name}`);
		}
		expect(bad).toEqual([]);
	});

	test('the raw-response detector catches each form and ignores look-alikes', () => {
		expect(rawResponse('return c.json({ a: 1 });')).toBe(true);
		expect(rawResponse('return c.body(null, 204);')).toBe(true);
		expect(rawResponse('return new Response("x");')).toBe(true);
		expect(rawResponse('return Response.json({});')).toBe(true);
		expect(rawResponse('return c.text("x");')).toBe(true);
		expect(rawResponse('return c.html("x");')).toBe(true);
		expect(rawResponse('return ctx.newResponse(null, 204);')).toBe(true);
		expect(rawResponse('return ctx.json({});')).toBe(true);
		expect(rawResponse('return c.status(201).json({});')).toBe(true);
		expect(rawResponse('return foo().json({});')).toBe(true);
		expect(rawResponse('return c?.json({});')).toBe(true);
		expect(rawResponse('const b = await request.json();')).toBe(false);
		expect(rawResponse('const b = await response.json();')).toBe(false);
		expect(rawResponse('const t = await res.text();')).toBe(false);
		expect(rawResponse('const b = await c.req.json();')).toBe(false);
		expect(rawResponse('const b = await req.json();')).toBe(false);
		expect(rawResponse('const b = await c.req.text();')).toBe(false);
		expect(rawResponse('return reply(c, HealthView, { status: "ok" });')).toBe(false);
		expect(rawResponse('// c.json({}) is not allowed\nconst s = "new Response(";')).toBe(false);
	});

	test('the main-only rule catches spaced and generic Bun.serve calls', () => {
		expect(mainOnly('Bun . serve({})')).toBe(true);
		expect(mainOnly('const s = Bun.serve<Ws>({});')).toBe(true);
		expect(mainOnly('handleSignals(x)')).toBe(true);
		expect(mainOnly('const x = 1;')).toBe(false);
	});

	test('no raw responses under modules/', async () => {
		const bad: string[] = [];
		for (const f of scan('apps/api/src/modules/**/*.ts')) {
			if (rawResponse(await read(f))) bad.push(f);
		}
		expect(bad).toEqual([]);
	});

	// A text heuristic, not a type checker. It cannot catch: an object literal behind a type alias is
	// fine by design, but a function type in a variable annotation (`export const f: (o: {}) => X`),
	// an `export { local }` re-export of an unexported function, a default-value expression holding a
	// `<` comparison, class fields holding arrow functions, or interface/type members (those belong
	// in a types.ts anyway). tsc cannot do this; the rule is a guard for the common forms.
	test('the inline-type detector flags object literals in exported signatures only', () => {
		const hit = (src: string) => inlineSignatureTypes(src);
		expect(hit('export function f(o: { a: number }) {}')).toEqual(['f']);
		expect(hit('export async function f(): Promise<{ a: number }> {}')).toEqual(['f']);
		expect(hit('export function f(): { a: number } { return x; }')).toEqual(['f']);
		expect(hit('export const f = async (o: { a: number }) => o.a;')).toEqual(['f']);
		expect(hit('export function f(): Record<string, { a: 1 }> {}')).toEqual(['f']);
		expect(hit('export function f(a: X | { a: 1 }) {}')).toEqual(['f']);
		expect(hit('export function f(a: Map<string, { a: 1 }>) {}')).toEqual(['f']);
		expect(hit('export function f(a: [{ a: 1 }, X]) {}')).toEqual(['f']);
		expect(hit('export function f(cb: (o: { a: 1 }) => void) {}')).toEqual(['f']);
		expect(hit('export function f<T extends X>({ a }: { a: T }) {}')).toEqual(['f']);
		expect(hit('export const f = (o: { a: 1 }) => o;')).toEqual(['f']);
		expect(hit('export const f = async (o: X): Promise<{ a: 1 }> => ({ a: 1 });')).toEqual(['f']);
		expect(hit('export const f = function (o: { a: 1 }) {};')).toEqual(['f']);
		expect(hit('export class A { run(o: { a: 1 }) {} }')).toEqual(['A.run']);
		expect(hit('export class A {\n\tstatic async make(): Promise<{ a: 1 }> {}\n}')).toEqual([
			'A.make',
		]);
		expect(hit('export class A { constructor(o: { a: 1 }) {} }')).toEqual(['A.constructor']);
		expect(
			hit(
				[
					'export function a({ x, y }: Opts) {}',
					'export function b({ x: { y } }: Opts, [{ z }]: Pair) {}',
					'export function c(o: Opts = { a: 1 }): Promise<Result> {}',
					'export function d<T extends { a: 1 }>(t: T): Record<string, T> {}',
					'export const e = ({ a }: Opts): readonly Foo[] => [];',
					'export const g = (n: number) => ({ n });',
					'export const k = <R extends X>(r: R): r is Extract<R, { ok: true }> => r.ok;',
					'export const h = { a: 1 } satisfies X;',
					'export const i = (fn(() => 1));',
					'function local(o: { a: 1 }) {}',
					'const arrow = (o: { a: 1 }) => o;',
					'class Local { run(o: { a: 1 }) {} }',
					'export class B { #p(o: { a: 1 }) {} field = { a: 1 }; get v(): number { return 1; } }',
					'// export function z(o: { a: 1 }) {}',
					"const s = 'export function z(o: { a: 1 }) {}';",
				].join('\n'),
			),
		).toEqual([]);
	});

	test('exported signatures use named types', async () => {
		const bad: string[] = [];
		for (const f of scan('apps/api/src/**/*.ts', 'packages/*/src/**/*.ts')) {
			for (const name of inlineSignatureTypes(await read(f))) bad.push(`${f}: ${name}`);
		}
		expect(bad).toEqual([]);
	});

	test('the exported-type detector flags each declaration form and ignores look-alikes', () => {
		expect(exportedTypeDecls('export interface A { a: 1 }')).toHaveLength(1);
		expect(exportedTypeDecls('export type A = { a: 1 };')).toHaveLength(1);
		expect(exportedTypeDecls('export type A<T> = T[];')).toHaveLength(1);
		expect(exportedTypeDecls('export type E = InstanceType<typeof Other>;')).toHaveLength(1);
		expect(exportedTypeDecls('export declare const x: number;')).toHaveLength(1);
		expect(exportedTypeDecls('const a = 1;\nexport type Db = ReturnType<typeof f>;')).toHaveLength(
			1,
		);
		expect(
			exportedTypeDecls(
				[
					"export type { A } from './types.ts';",
					"export type * from './types.ts';",
					'interface Local { a: 1 }',
					'type Alias = number;',
					'// export interface C {}',
					"const s = 'export type A = 1';",
					'export class K {}',
					'export const E = defineError(1);\nexport type E = InstanceType<typeof E>;',
					'export const Env = v.object({});\nexport type Env = v.InferOutput<typeof Env>;',
					'export const typeOf = 1;',
				].join('\n'),
			),
		).toEqual([]);
		expect(isTypesFile('apps/api/src/bootstrap/types.ts')).toBe(true);
		expect(isTypesFile('apps/api/src/modules/health/health.types.ts')).toBe(true);
		expect(isTypesFile('packages/lib/src/log.types.ts')).toBe(true);
		expect(isTypesFile('packages/lib/src/retry.ts')).toBe(false);
		expect(isTypesFile('packages/lib/src/mytypes.ts')).toBe(false);
	});

	// lib and contracts are libraries: a module declares the types it offers (contracts infer them
	// beside their schemas). Classes are values and stay put.
	test('exported types live in types files', async () => {
		const bad: string[] = [];
		for (const f of scan('apps/api/src/**/*.ts', 'packages/*/src/**/*.ts')) {
			if (isTypesFile(f) || /^packages\/(?:lib|contracts)\/src\//.test(f)) continue;
			for (const d of exportedTypeDecls(await read(f))) bad.push(`${f}: ${d}`);
		}
		expect(bad).toEqual([]);
	});

	test('the shared-imports detector catches alias and relative imports above shared/', () => {
		const from = 'apps/api/src/shared/http/reply.ts';
		const up = ['middleware', 'bootstrap', 'modules', 'infra'];
		expect(
			importsUnder(from, "import { x } from '#src/middleware/error-handler.ts';", up),
		).toHaveLength(1);
		expect(importsUnder(from, "import { x } from '../../infra/valkey.ts';", up)).toHaveLength(1);
		expect(
			importsUnder(from, "import { x } from '#src/modules/health/health.module.ts';", up),
		).toHaveLength(1);
		expect(importsUnder(from, "import { x } from '#src/shared/http/problem.ts';", up)).toEqual([]);
		expect(importsUnder(from, "import { x } from './app-env.ts';", up)).toEqual([]);
		expect(importsUnder(from, "import { x } from 'hono';", up)).toEqual([]);
	});

	test('shared/ imports nothing above it', async () => {
		const bad: string[] = [];
		for (const f of scan('apps/api/src/shared/**/*.ts')) {
			for (const s of importsUnder(f, await read(f), [
				'middleware',
				'bootstrap',
				'modules',
				'infra',
			])) {
				bad.push(`${f} -> ${s}`);
			}
		}
		expect(bad).toEqual([]);
	});

	// lib takes its types from contracts, so contracts reaching back into the workspace would be a cycle.
	const leavesContracts = (file: string, src: string) =>
		specifiers(src).filter((s) => {
			if (s.startsWith('@starter/')) return true;
			const to = resolveSpec(file, s);
			return to !== undefined && !to.startsWith('packages/contracts/src/');
		});

	test('the contracts-leaf detector catches workspace and out-of-package imports', () => {
		const from = 'packages/contracts/src/meta.ts';
		expect(leavesContracts(from, "import { x } from '@starter/lib/errors';")).toHaveLength(1);
		expect(leavesContracts(from, "import { x } from '../../lib/src/errors.ts';")).toHaveLength(1);
		expect(leavesContracts(from, "import * as v from 'valibot';")).toEqual([]);
		expect(leavesContracts(from, "export * from './problem.ts';")).toEqual([]);
	});

	test('contracts import nothing from the workspace', async () => {
		const bad: string[] = [];
		for (const f of scan('packages/contracts/src/**/*.ts')) {
			for (const s of leavesContracts(f, await read(f))) bad.push(`${f} -> ${s}`);
		}
		expect(bad).toEqual([]);
	});

	test('the object-schema detector flags each valibot object form and ignores look-alikes', () => {
		expect(objectSchema('const s = v.object({ a: v.string() });')).toBe(true);
		expect(objectSchema('const s = v.strictObject({});')).toBe(true);
		expect(objectSchema('const s = v.looseObject({});')).toBe(true);
		expect(objectSchema('const s = v.objectWithRest({}, v.string());')).toBe(true);
		expect(objectSchema('const s = v.record(v.string(), v.number());')).toBe(false);
		expect(objectSchema('// v.object({})\nconst t = "v.object(";')).toBe(false);
		expect(objectSchema('const s = obj.object(1);')).toBe(false);
	});

	test('object schemas live only in contracts and config', async () => {
		const bad: string[] = [];
		for (const f of scan('apps/api/src/**/*.ts', 'packages/*/src/**/*.ts')) {
			if (f.startsWith('packages/contracts/src/') || f === 'apps/api/src/bootstrap/config.ts') {
				continue;
			}
			if (objectSchema(await read(f))) bad.push(f);
		}
		expect(bad).toEqual([]);
	});
});
