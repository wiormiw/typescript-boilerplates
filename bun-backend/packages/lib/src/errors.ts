/**
 * Every deliberate failure is an AppError with a `kind` and a stable `code`. A service says what
 * went wrong; `httpStatusByKind` alone decides which HTTP status that becomes.
 */
export type ErrorKind =
	| 'validation'
	| 'payload_too_large'
	| 'not_found'
	| 'conflict'
	| 'unauthorized'
	| 'forbidden'
	| 'rate_limited'
	| 'external'
	| 'unavailable'
	| 'internal';

export interface ErrorOptions {
	details?: Record<string, unknown>;
	cause?: unknown;
}

/** Stable, client-facing codes. Add freely; clients switch on these, so never rename one. */
export const ErrorCode = {
	auth: {
		unauthenticated: 'auth.session.unauthenticated',
		sessionExpired: 'auth.session.expired',
		banned: 'auth.account.suspended',
		invalidGrant: 'auth.native.invalid_grant',
		redirectNotAllowed: 'auth.native.redirect_not_allowed',
		flowExpired: 'auth.native.flow_expired',
		providerNotConfigured: 'auth.provider.not_configured',
	},
	common: {
		validation: 'common.request.validation_failed',
		cancelled: 'common.request.cancelled',
		rateLimited: 'common.request.rate_limited',
		payloadTooLarge: 'common.request.payload_too_large',
		timeout: 'common.request.timeout',
		unexpected: 'common.server.unexpected',
		forbidden: 'common.auth.forbidden',
		routeNotFound: 'common.route.not_found',
		unavailable: 'common.request.unavailable',
	},
} as const;

export class AppError extends Error {
	readonly kind: ErrorKind;
	readonly code: string;
	/** Shown to the client, so never anything secret. */
	readonly details?: Readonly<Record<string, unknown>>;

	constructor(kind: ErrorKind, code: string, message: string, options: ErrorOptions = {}) {
		super(message, { cause: options.cause });
		this.name = 'AppError';
		this.kind = kind;
		this.code = code;
		if (options.details) this.details = options.details;
	}
}

/**
 * A class for one stable error code. Its kind and code are literal types, so two errors are
 * never confused in a union, and it is an AppError, so the problem renderer handles it as is.
 */
export function defineError<const K extends ErrorKind, const C extends string>(
	kind: K,
	code: C,
	defaultMessage: string,
) {
	return class extends AppError {
		static readonly kind = kind;
		static readonly code = code;
		declare readonly kind: K;
		declare readonly code: C;
		constructor(message: string = defaultMessage, options?: ErrorOptions) {
			super(kind, code, message, options);
		}
	};
}

// One class per code. A code answered with different statuses at different sites gets one class
// per status, so a union never holds two classes the compiler can't tell apart.

export const Unauthenticated = defineError(
	'unauthorized',
	ErrorCode.auth.unauthenticated,
	'Sign in to access this resource.',
);
export type Unauthenticated = InstanceType<typeof Unauthenticated>;
export const SessionExpired = defineError(
	'unauthorized',
	ErrorCode.auth.sessionExpired,
	'Your session has expired. Sign in again.',
);
export type SessionExpired = InstanceType<typeof SessionExpired>;
export const AccountSuspended = defineError(
	'forbidden',
	ErrorCode.auth.banned,
	'This account is suspended.',
);
export type AccountSuspended = InstanceType<typeof AccountSuspended>;
// One message for every way a native code can fail, so a caller learns nothing about which.
export const InvalidGrant = defineError(
	'validation',
	ErrorCode.auth.invalidGrant,
	'The code or verifier is not valid.',
);
export type InvalidGrant = InstanceType<typeof InvalidGrant>;
export const RedirectNotAllowed = defineError(
	'validation',
	ErrorCode.auth.redirectNotAllowed,
	'That redirect_uri is not allowed.',
);
export type RedirectNotAllowed = InstanceType<typeof RedirectNotAllowed>;
export const SignInFlowExpired = defineError(
	'validation',
	ErrorCode.auth.flowExpired,
	'This sign-in has expired. Start again.',
);
export type SignInFlowExpired = InstanceType<typeof SignInFlowExpired>;
export const ProviderNotConfigured = defineError(
	'not_found',
	ErrorCode.auth.providerNotConfigured,
	'That sign-in provider is not configured.',
);
export type ProviderNotConfigured = InstanceType<typeof ProviderNotConfigured>;

export const ValidationFailed = defineError(
	'validation',
	ErrorCode.common.validation,
	'Invalid request.',
);
export type ValidationFailed = InstanceType<typeof ValidationFailed>;
/** The 400 answered today for a body or file over its limit (the route-level 413 is another class). */
export const ContentTooLarge = defineError(
	'validation',
	ErrorCode.common.payloadTooLarge,
	'That is larger than allowed.',
);
export type ContentTooLarge = InstanceType<typeof ContentTooLarge>;
/** A request body over a route's own ceiling, refused as it streams in: the 413 a proxy would send. */
export const PayloadTooLarge = defineError(
	'payload_too_large',
	ErrorCode.common.payloadTooLarge,
	'The request body is larger than allowed.',
);
export type PayloadTooLarge = InstanceType<typeof PayloadTooLarge>;
// Stopped before it finished, so retrying later can work: the same answer as a shutdown's.
export const RequestCancelled = defineError(
	'unavailable',
	ErrorCode.common.cancelled,
	'The request was cancelled.',
);
export type RequestCancelled = InstanceType<typeof RequestCancelled>;
export const ServiceUnavailable = defineError(
	'unavailable',
	ErrorCode.common.unavailable,
	'The server is shutting down. Try again shortly.',
);
export type ServiceUnavailable = InstanceType<typeof ServiceUnavailable>;
export const RateLimited = defineError(
	'rate_limited',
	ErrorCode.common.rateLimited,
	'Too many requests. Slow down.',
);
export type RateLimited = InstanceType<typeof RateLimited>;
export const RequestTimeout = defineError(
	'external',
	ErrorCode.common.timeout,
	'The request took too long.',
);
export type RequestTimeout = InstanceType<typeof RequestTimeout>;
export const UnexpectedError = defineError(
	'internal',
	ErrorCode.common.unexpected,
	'Unexpected error',
);
export type UnexpectedError = InstanceType<typeof UnexpectedError>;
export const Forbidden = defineError(
	'forbidden',
	ErrorCode.common.forbidden,
	'You do not have permission to do that.',
);
export type Forbidden = InstanceType<typeof Forbidden>;
export const RouteNotFound = defineError(
	'not_found',
	ErrorCode.common.routeNotFound,
	'No such route.',
);
export type RouteNotFound = InstanceType<typeof RouteNotFound>;
