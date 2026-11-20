import type { SqlTarget } from '@starter/db';
import type { DeleteAccountBody, NativeFinishQuery, UpdateSettingsBody } from '@starter/contracts';
import type { Logger } from '@starter/lib/log';
import type { Auth, AuthCodeStore } from '#src/infra/types.ts';

// Wire shapes are contracts (`NativeStartQuery`, `UserView`, ...): use cases take and return them
// as they are. This file holds only what contracts don't describe: deps and the inputs that add
// the caller to a contract.

export interface AuthModuleDeps {
	auth: Pick<Auth, 'handler' | 'api' | 'options'>;
	/** `asUser` runs on it and cancels through it; a `BunSqlDatabase` satisfies it. */
	database: SqlTarget;
	logger: Logger;
	authCodes: AuthCodeStore;
	/** `NATIVE_REDIRECT_URIS`: a `redirect_uri` is accepted only if it equals one of these. */
	redirectUris: readonly string[];
	/** `NATIVE_FLOW_TTL_S`: how long a started sign-in waits for the browser to come back. */
	flowTtlS: number;
	/** `NATIVE_CODE_TTL_S`: how long the one-time code waits for the app's exchange. */
	codeTtlS: number;
}

/** What a use case takes from the module; better-auth is only for those that call it. */
export type AuthUseCaseDeps = Pick<AuthModuleDeps, 'database' | 'logger'>;
export type AuthApiDeps = Pick<AuthModuleDeps, 'database' | 'logger' | 'auth'>;

/** What the native sign-in routes need: better-auth's API, the one-time store and the allowlist. */
export interface NativeDeps extends Pick<
	AuthModuleDeps,
	'authCodes' | 'redirectUris' | 'flowTtlS' | 'codeTtlS'
> {
	/** `options` names the session cookie the finish route reads. */
	auth: Pick<Auth, 'api' | 'options'>;
}

export interface UpdateSettingsInput {
	userId: string;
	patch: UpdateSettingsBody;
}

/** Who is calling; their request headers prove it to better-auth. */
export interface CallerInput {
	userId: string;
	headers: Headers;
}

export interface DeleteAccountInput extends CallerInput, DeleteAccountBody {}

export interface FinishGoogleSignInInput extends NativeFinishQuery {
	/** The browser's request headers: its session cookie is how the session is found. */
	headers: Headers;
}

/** Where to send the browser, with the cookies to set or drop on the way. */
export interface BrowserRedirect {
	location: string;
	cookies: string[];
}
