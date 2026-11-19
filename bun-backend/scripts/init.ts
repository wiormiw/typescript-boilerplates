// Renames the boilerplate: `bun scripts/init.ts my-app`.
// Replaces the placeholder (starter / Starter / STARTER) in every text file, drops the "Using this
// boilerplate" section from the README, deletes itself, then runs `bun install` and the formatter.
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
	console.error('usage: bun scripts/init.ts <kebab-case-name>   (for example: my-app)');
	process.exit(1);
}

const pascal = name
	.split('-')
	.map((part) => part[0]!.toUpperCase() + part.slice(1))
	.join('');
const upper = name.toUpperCase().replaceAll('-', '_');

const root = join(import.meta.dir, '..');
const SKIP = new Set(['node_modules', '.git']);

async function* files(dir: string): AsyncGenerator<string> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (SKIP.has(entry.name)) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* files(path);
		else yield path;
	}
}

let changed = 0;
for await (const path of files(root)) {
	if (path === join(root, 'scripts', 'init.ts')) continue;
	const bytes = await readFile(path);
	// Binary files have a NUL byte; leave them alone.
	if (bytes.includes(0)) continue;
	let text = bytes.toString('utf8');
	const before = text;
	text = text.replaceAll('starter', name).replaceAll('Starter', pascal).replaceAll('STARTER', upper);
	if (path.endsWith('README.md')) {
		text = text.replace(/<!-- boilerplate:start -->[\s\S]*?<!-- boilerplate:end -->\n\n?/, '');
	}
	if (text !== before) {
		await writeFile(path, text);
		changed++;
	}
}

await rm(join(root, 'scripts', 'init.ts'));
// `scripts/` only held this file.
if ((await readdir(join(root, 'scripts'))).length === 0) await rm(join(root, 'scripts'), { recursive: true });

console.log(`Renamed to "${name}" in ${changed} files.`);

// A longer or shorter name changes line lengths and the order of dependencies, so format again.
for (const command of [['bun', 'install'], ['bun', 'run', 'format']]) {
	const run = Bun.spawn(command, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
	if ((await run.exited) !== 0) {
		console.error(`\`${command.join(' ')}\` failed; run it yourself, then \`git init\`.`);
		process.exit(1);
	}
}
console.log('Done. Next: git init');
