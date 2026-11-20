import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins/bearer';
import { asUser, eraseAudit, recordAudit, schema, type BunSqlDatabase, type Tx } from '@starter/db';
import * as v from 'valibot';
import { UserView } from '@starter/contracts';
import { untilAborted } from '@starter/lib/abort';
import type { Logger } from '@starter/lib/log';
import { ok } from '@starter/lib/result';
import type { Env } from '#src/bootstrap/config.ts';
import type { Auth, Mailer, RateLimitStore } from '#src/infra/types.ts';
import { CLIENT_ADDRESS_HEADER } from '#src/shared/http/client-address.ts';
import type { Authenticate } from '#src/shared/http/types.ts';

interface AuthOptions {
	/** The adapter reads `db`; the hooks run `asUser`, which cancels through `control`. */
	database: Pick<BunSqlDatabase, 'db' | 'control'>;
	env: Pick<
		Env,
		| 'AUTH_SECRET'
		| 'AUTH_BASE_URL'
		| 'SIGNUP_ENABLED'
		| 'GOOGLE_CLIENT_ID'
		| 'GOOGLE_CLIENT_SECRET'
		| 'AUTH_RATE_LIMIT_MAX'
		| 'AUTH_RATE_LIMIT_WINDOW_S'
	>;
	mailer: Mailer;
	/** Shared buckets (Valkey), so a limit holds across API instances and restarts. */
	rateLimit: RateLimitStore;
	logger: Logger;
	/** The lifecycle's signal: better-auth hands its hooks none of their own. */
	shutdown: AbortSignal;
}

const { user, session, account, verification, userSettings } = schema;

/**
 * The better-auth instance. Mounting it as routes is the router's job; this only configures it.
 * better-auth's own tables carry no RLS, so it reads them through the plain pool; the rows we own
 * (`user_settings`, `audit`) are written by hooks that run as the user, under RLS.
 */
export function createAuth(options: AuthOptions) {
	const { database, env, mailer, shutdown } = options;
	const log = options.logger.child({ component: 'auth' });
	// Guessing a password and registering in bulk are throttled alike, per client address.
	const credentialAttempts = { window: env.AUTH_RATE_LIMIT_WINDOW_S, max: env.AUTH_RATE_LIMIT_MAX };

	// A failed hook fails the operation, but `user.create.after` runs once the user row is written,
	// so the user can be left without a settings row: settings reads create it lazily. Only the
	// user id is logged: never the email or a token.
	async function asHook(
		hook: string,
		userId: string,
		work: (tx: Tx) => Promise<void>,
	): Promise<void> {
		try {
			// The work cannot return an err, so a failure here is a throw: cancellation or the database.
			await asUser(
				database,
				{ userId, signal: shutdown, operation: `auth.${hook}`, logger: log },
				async (tx) => {
					await work(tx);
					return ok(undefined);
				},
			);
		} catch (error) {
			log.error({ err: error, hook, userId }, 'auth hook failed');
			throw error;
		}
	}

	return betterAuth({
		basePath: '/auth',
		baseURL: env.AUTH_BASE_URL,
		secret: env.AUTH_SECRET,
		database: drizzleAdapter(database.db, {
			provider: 'pg',
			schema: { user, session, account, verification },
		}),
		advanced: {
			// Without this better-auth makes 32-character ids, which a uuid column refuses.
			database: { generateId: () => Bun.randomUUIDv7() },
			// The address the router puts there from the socket; never x-forwarded-for, which any
			// client can set (to dodge a rate limit or forge a session's recorded address).
			ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS_HEADER] },
		},
		telemetry: { enabled: false },
		// better-auth's own lines go to our logger (stdout and Loki), not its console printer. Only the
		// message: the extra arguments can carry an email or a token.
		logger: { log: (level, message) => log[level]({ source: 'better-auth' }, message) },
		emailAndPassword: {
			enabled: true,
			disableSignUp: !env.SIGNUP_ENABLED,
			requireEmailVerification: true,
			password: {
				hash: (password) => Bun.password.hash(password, 'argon2id'),
				verify: ({ hash, password }) => Bun.password.verify(password, hash),
			},
		},
		emailVerification: {
			sendOnSignUp: true,
			// better-auth does not await this, so a failure is ours to log.
			sendVerificationEmail: async ({ user: who, url }) => {
				try {
					await mailer.send({ to: who.email, subject: 'Verify your email', text: url }, shutdown);
				} catch (error) {
					log.error({ err: error, userId: who.id }, 'verification mail failed');
				}
			},
		},
		socialProviders:
			env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
				? {
						google: {
							clientId: env.GOOGLE_CLIENT_ID,
							clientSecret: env.GOOGLE_CLIENT_SECRET,
							// Closed sign-up must hold for Google too, or it is a way in. Both are needed:
							// a client's `requestSignUp: true` overrides disableImplicitSignUp alone.
							disableImplicitSignUp: !env.SIGNUP_ENABLED,
							disableSignUp: !env.SIGNUP_ENABLED,
						},
					}
				: {},
		plugins: [bearer()],
		// Ours wrap these: DELETE /me requires the password for a password account (better-auth
		// alone accepts a fresh session), and DELETE /me/sessions writes the audit row. Their own
		// routes would bypass both; `auth.api.*` still reaches them from our use cases.
		disabledPaths: ['/delete-user', '/revoke-sessions'],
		rateLimit: {
			enabled: true,
			customStorage: options.rateLimit,
			customRules: {
				'/sign-in/email': credentialAttempts,
				'/sign-up/email': credentialAttempts,
			},
		},
		user: {
			deleteUser: {
				enabled: true,
				beforeDelete: async (who) => {
					await asHook('user.deleteUser.beforeDelete', who.id, async (tx) => {
						// The deletion record is the only row left: no IP or user agent.
						await eraseAudit(tx, who.id);
						await recordAudit(tx, { userId: who.id, action: 'account_deleted' });
					});
				},
			},
		},
		databaseHooks: {
			user: {
				create: {
					after: async (created) => {
						await asHook('user.create.after', created.id, async (tx) => {
							await tx.insert(userSettings).values({ userId: created.id });
						});
					},
				},
			},
			session: {
				create: {
					after: async (opened) => {
						await asHook('session.create.after', opened.userId, async (tx) => {
							await recordAudit(tx, {
								userId: opened.userId,
								action: 'sign_in',
								ip: opened.ipAddress ?? undefined,
								userAgent: opened.userAgent ?? undefined,
							});
						});
					},
				},
			},
		},
	});
}

/**
 * Resolves headers to a session through better-auth. It takes no signal, so the wait is cut short
 * here. The user is parsed against the contract: a violation is our bug and throws (a 500).
 */
export function createAuthenticate(auth: Pick<Auth, 'api'>): Authenticate {
	return async (headers, signal) => {
		const found = await untilAborted(auth.api.getSession({ headers }), signal);
		if (!found) return undefined;
		const { user, session } = found;
		return {
			user: v.parse(UserView, {
				id: user.id,
				email: user.email,
				name: user.name,
				emailVerified: user.emailVerified,
			}),
			sessionId: session.id,
		};
	};
}
