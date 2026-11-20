import * as v from 'valibot';

/** The signed-in user as a client sees them. */
export const UserView = v.object({
	id: v.pipe(v.string(), v.uuid()),
	email: v.pipe(v.string(), v.email()),
	name: v.string(),
	emailVerified: v.boolean(),
});
export type UserView = v.InferOutput<typeof UserView>;

// Built once: the list is large and the check runs on every settings write.
const TIME_ZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);

export const TimeZone = v.pipe(
	v.string(),
	v.check((zone) => TIME_ZONES.has(zone), 'must be an IANA time zone'),
);
export type TimeZone = v.InferOutput<typeof TimeZone>;

/** What a user can change about their account. */
export const SettingsView = v.object({
	timezone: TimeZone,
	emailReminders: v.boolean(),
	llmEnabled: v.boolean(),
});
export type SettingsView = v.InferOutput<typeof SettingsView>;

/** `GET /me`: who is signed in and how their account is set. */
export const MeView = v.object({ user: UserView, settings: SettingsView });
export type MeView = v.InferOutput<typeof MeView>;

/** `PATCH /me/settings`: any of the settings, at least one. */
export const UpdateSettingsBody = v.pipe(
	v.strictObject({
		timezone: v.optional(TimeZone),
		emailReminders: v.optional(v.boolean()),
		llmEnabled: v.optional(v.boolean()),
	}),
	v.check((body) => Object.keys(body).length > 0, 'at least one setting is required'),
);
export type UpdateSettingsBody = v.InferOutput<typeof UpdateSettingsBody>;

/** `DELETE /me`: the password proves it is the owner; absent for an account without one. */
export const DeleteAccountBody = v.object({ password: v.optional(v.string()) });
export type DeleteAccountBody = v.InferOutput<typeof DeleteAccountBody>;

/** `GET /auth/native/google/start`: the native client's PKCE challenge and where to send it back. */
export const NativeStartQuery = v.object({
	// base64url(sha256(verifier)) is always 43 characters.
	code_challenge: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/)),
	code_challenge_method: v.literal('S256'),
	redirect_uri: v.string(),
	state: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
});
export type NativeStartQuery = v.InferOutput<typeof NativeStartQuery>;

/**
 * `GET /auth/native/google/finish`: the flow that `start` opened, and the error better-auth adds
 * when the round trip failed (consent denied, state mismatch).
 */
export const NativeFinishQuery = v.object({
	flow: v.pipe(v.string(), v.uuid()),
	error: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
export type NativeFinishQuery = v.InferOutput<typeof NativeFinishQuery>;

/** `POST /auth/native/exchange`: the one-time code and the verifier its challenge came from. */
export const NativeExchangeBody = v.object({
	code: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
	code_verifier: v.pipe(
		v.string(),
		v.minLength(43),
		v.maxLength(128),
		v.regex(/^[A-Za-z0-9\-._~]+$/),
	),
});
export type NativeExchangeBody = v.InferOutput<typeof NativeExchangeBody>;

// better-auth's answers, as the API reads them. Upstream shapes, never sent on our wire: both
// fields of a failure are optional because better-auth guarantees neither.

/** A failure from better-auth: its handler's error body, or what an `APIError` carries. */
export const BetterAuthFailure = v.object({
	code: v.optional(v.string()),
	message: v.optional(v.string()),
});
export type BetterAuthFailure = v.InferOutput<typeof BetterAuthFailure>;

/** better-auth's answer to a social sign-in with `disableRedirect`: where to send the browser. */
export const BetterAuthSocialRedirect = v.object({ url: v.pipe(v.string(), v.url()) });
export type BetterAuthSocialRedirect = v.InferOutput<typeof BetterAuthSocialRedirect>;

/** The bearer token a native client sends as `Authorization: Bearer`, and who it is for. */
export const SessionTokenView = v.object({ token: v.string(), user: UserView });
export type SessionTokenView = v.InferOutput<typeof SessionTokenView>;
