import { expect, test } from 'bun:test';
import { containing, first, one, pgArray } from '@starter/db/sql';

test('an array literal binds as one text parameter', () => {
	expect(pgArray(['a', 'b"c'])).toBe('{"a","b\\"c"}');
	expect(containing('50%_off')).toBe('%50\\%\\_off%');
});

test('one returns the single row and throws, naming it, when there is none', () => {
	expect(one([7], 'count')).toBe(7);
	expect(() => one([], 'platform counts')).toThrow('expected one platform counts, got 0');
	expect(() => one([1, 2], 'platform counts')).toThrow('expected one platform counts, got 2');
});

test('first returns the row or undefined', () => {
	expect(first([1, 2])).toBe(1);
	expect(first([])).toBeUndefined();
});
