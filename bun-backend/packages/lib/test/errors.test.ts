import { describe, expect, test } from 'bun:test';
import * as errors from '@starter/lib/errors';
import {
	AppError,
	ErrorCode,
	RouteNotFound,
	SessionExpired,
	Unauthenticated,
	ServiceUnavailable,
	defineError,
} from '@starter/lib/errors';
import { httpStatusByKind, toProblem } from '@starter/lib/problem';
import { err, ok, type Result } from '@starter/lib/result';
import { expectErr } from '@starter/lib/testing';

/**
 * Every class, with the code and status it answers with today. Written out rather than derived,
 * so a class whose kind changes fails here instead of silently moving a status on the wire.
 * The statuses come from the `fail.<kind>(ErrorCode…)` pairs the code used on 2026-10-16.
 */
const catalogue: Record<string, readonly [code: string, status: number]> = {
	AccountSuspended: ['auth.account.suspended', 403],
	Unauthenticated: ['auth.session.unauthenticated', 401],
	SessionExpired: ['auth.session.expired', 401],
	Forbidden: ['common.auth.forbidden', 403],
	ContentTooLarge: ['common.request.payload_too_large', 400],
	// The route-level ceiling on uploads answers 413 with the same code (Task 6 of Plan 3).
	PayloadTooLarge: ['common.request.payload_too_large', 413],
	RateLimited: ['common.request.rate_limited', 429],
	RouteNotFound: ['common.route.not_found', 404],
	RequestTimeout: ['common.request.timeout', 502],
	RequestCancelled: ['common.request.cancelled', 503],
	ServiceUnavailable: ['common.request.unavailable', 503],
	UnexpectedError: ['common.server.unexpected', 500],
	ValidationFailed: ['common.request.validation_failed', 400],
};

type ErrorClass = (new () => AppError) & { kind: string; code: string };

const classes = (Object.entries(errors) as [string, unknown][]).filter(
	(entry): entry is [string, ErrorClass] =>
		typeof entry[1] === 'function' && entry[1].prototype instanceof AppError,
);

const leaves = (node: object): string[] =>
	Object.values(node).flatMap((v) => (typeof v === 'string' ? [v] : leaves(v as object)));

describe('error catalogue', () => {
	test('lists exactly the exported classes', () => {
		expect(classes.map(([name]) => name).toSorted()).toEqual(Object.keys(catalogue).toSorted());
	});

	test.each(Object.entries(catalogue))('%s keeps its code and status', (name, [code, status]) => {
		const Class = classes.find(([n]) => n === name)?.[1];
		if (!Class) throw new Error(`${name} is not exported`);
		const error = new Class();
		expect(error).toBeInstanceOf(AppError);
		expect(error.code).toBe(code);
		expect(httpStatusByKind[error.kind]).toBe(status);
		expect(Class.code).toBe(error.code);
		expect(Class.kind).toBe(error.kind);
		expect(error.message.length).toBeGreaterThan(0);
	});

	test('every stable code has a class', () => {
		const covered = new Set(Object.values(catalogue).map(([code]) => code));
		expect(leaves(ErrorCode).filter((code) => !covered.has(code))).toEqual([]);
	});
});

describe('defineError', () => {
	test('takes a message and options, falling back to the default message', () => {
		const cause = new Error('boom');
		const error = new RouteNotFound('No route "/x".', { details: { path: '/x' }, cause });
		expect(error.message).toBe('No route "/x".');
		expect(error.details).toEqual({ path: '/x' });
		expect(error.cause).toBe(cause);
		expect(new RouteNotFound().message).toBe('No such route.');
	});

	test('carries kind and code as literal types', () => {
		const Gone = defineError('not_found', 'test.gone', 'Gone.');
		const kind: 'not_found' = new Gone().kind;
		const code: 'test.gone' = Gone.code;
		expect([kind, code]).toEqual(['not_found', 'test.gone']);
	});

	test('two codes are never assignable to each other', () => {
		// @ts-expect-error an expired session is not a missing one
		const missing: Unauthenticated = new SessionExpired();
		// Different kinds keep two classes apart as well.
		// @ts-expect-error a missing route is not an unauthenticated caller
		const caller: Unauthenticated = new RouteNotFound();
		expect([missing, caller]).toHaveLength(2);
	});

	test('unavailable is a 503 with its own title', () => {
		const { status, body } = toProblem(new ServiceUnavailable(), { requestId: 'r1' });
		expect(status).toBe(503);
		expect(body).toMatchObject({
			code: 'common.request.unavailable',
			title: 'Service unavailable',
		});
	});
});

describe('expectErr', () => {
	const failing = (): Result<number, RouteNotFound | SessionExpired> =>
		err(new SessionExpired('Sign in again.'));

	test('takes a class and returns the error narrowed to it', () => {
		const error: SessionExpired = expectErr(failing(), SessionExpired);
		expect(error.message).toBe('Sign in again.');
	});

	test('takes a code and returns the error with that code', () => {
		const error: SessionExpired = expectErr(failing(), 'auth.session.expired');
		expect(error.code).toBe('auth.session.expired');
	});

	test('still takes any code for an untyped result', () => {
		const untyped: Result<number, AppError> = err(new RouteNotFound());
		expect(expectErr(untyped, ErrorCode.common.routeNotFound)).toBeInstanceOf(RouteNotFound);
	});

	test('refuses a class or code the result cannot hold', () => {
		if (Date.now() < 0) {
			// @ts-expect-error Unauthenticated is not one of the errors
			expectErr(failing(), Unauthenticated);
			// @ts-expect-error nor is its code
			expectErr(failing(), 'auth.session.unauthenticated');
		}
	});

	test('fails the test on a success or another error', () => {
		const success = (): Result<number, RouteNotFound> => ok(1);
		expect(() => expectErr(success(), RouteNotFound)).toThrow();
		expect(() => expectErr(failing(), RouteNotFound)).toThrow();
		expect(() => expectErr(failing(), 'common.route.not_found')).toThrow();
	});
});
