import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import * as v from 'valibot';
import * as contracts from '@starter/contracts';

const samples = new URL('../samples/', import.meta.url);

// A View is a response body, a Query a request's query string; both ship a sample.
const views = Object.entries(contracts).filter(
	([name]) => name.endsWith('View') || name.endsWith('Query'),
);

describe('every *View and *Query export has a sample in samples/ that parses', () => {
	for (const [name, view] of views) {
		test(name, async () => {
			const sample: unknown = await Bun.file(new URL(`${name}.json`, samples)).json();
			const output = v.parse(view as v.GenericSchema, sample);
			// A View's wire is JSON text, so its round trip must still parse. A Query's sample is
			// already the wire form (strings), and its output is a different shape.
			if (name.endsWith('Query')) return;
			const wire: unknown = JSON.parse(JSON.stringify(output));
			expect(v.safeParse(view as v.GenericSchema, wire).issues).toBeUndefined();
		});
	}

	test('no sample is orphaned', () => {
		const names = new Set(views.map(([name]) => `${name}.json`));
		expect(readdirSync(samples).filter((file) => !names.has(file))).toEqual([]);
	});
});
