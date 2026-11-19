import { describe, expect, test } from 'bun:test';
import { Forbidden, UnexpectedError } from '@starter/lib/errors';
import { toProblem } from '@starter/lib/problem';

describe('problem', () => {
	test('a kind decides the status, and the code is on the body', () => {
		const { status, body } = toProblem(new Forbidden('Taken.'), {
			requestId: 'r1',
			traceId: 't1',
		});
		expect(status).toBe(403);
		expect(body).toMatchObject({
			code: 'common.auth.forbidden',
			detail: 'Taken.',
			requestId: 'r1',
			traceId: 't1',
		});
	});

	test('an internal error never shows its message', () => {
		const { status, body } = toProblem(new UnexpectedError('password=hunter2'), {
			requestId: 'r1',
		});
		expect(status).toBe(500);
		expect(body.detail).not.toContain('hunter2');
		expect(body.detail).toContain('request id');
	});

	test('traceId is omitted when there is none', () => {
		const { body } = toProblem(new Forbidden('Taken.'), { requestId: 'r1' });
		expect(body.requestId).toBe('r1');
		expect('traceId' in body).toBe(false);
	});
});
