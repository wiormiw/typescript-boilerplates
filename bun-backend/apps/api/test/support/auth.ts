import { SQL } from 'bun';
import { silentLogger, type Logger } from '@starter/lib/log';
import { createAuth } from '#src/infra/auth.ts';
import type { MailMessage, RateLimitStore } from '#src/infra/types.ts';
import { defaults } from './env.ts';
import { ownerDatabaseUrl } from './infra.ts';
import { unlimited } from './rate-limit.ts';

type AuthOptions = Parameters<typeof createAuth>[0];
type AuthEnv = AuthOptions['env'];

/** better-auth settings for tests: sign-up open unless a test closes it, no Google. */
export const authEnv = (overrides: Partial<AuthEnv> = {}): AuthEnv => ({
	AUTH_SECRET: 'x'.repeat(32),
	AUTH_BASE_URL: 'http://127.0.0.1:4600',
	SIGNUP_ENABLED: true,
	GOOGLE_CLIENT_ID: undefined,
	GOOGLE_CLIENT_SECRET: undefined,
	AUTH_RATE_LIMIT_MAX: defaults.AUTH_RATE_LIMIT_MAX,
	AUTH_RATE_LIMIT_WINDOW_S: defaults.AUTH_RATE_LIMIT_WINDOW_S,
	...overrides,
});

interface TestAuthOptions {
	database: AuthOptions['database'];
	env?: Partial<AuthEnv>;
	rateLimit?: RateLimitStore;
	logger?: Logger;
	shutdown?: AbortSignal;
}

/** The real `createAuth`, with its mail kept in `mail` and no rate limit unless one is given. */
export function testAuth(options: TestAuthOptions) {
	const mail: MailMessage[] = [];
	const auth = createAuth({
		database: options.database,
		env: authEnv(options.env),
		mailer: {
			async send(message) {
				mail.push(message);
			},
		},
		rateLimit: options.rateLimit ?? unlimited,
		logger: options.logger ?? silentLogger(),
		shutdown: options.shutdown ?? new AbortController().signal,
	});
	return { auth, mail };
}

/**
 * Users a test creates, removed afterwards as the owner. Audit rows have no foreign key and outlive
 * a deleted user, so they go by user id: ids are looked up by email while the user exists, and a
 * test that deletes a user records its id first with `track`.
 */
export function testUsers(tag: string) {
	const owner = new SQL({ url: ownerDatabaseUrl, max: 2 });
	const emails: string[] = [];
	const ids: string[] = [];
	return {
		owner,
		/** A fresh address, cleaned up later. */
		email(): string {
			const value = `${tag}-${Bun.randomUUIDv7()}@example.test`;
			emails.push(value);
			return value;
		},
		track(id: string): void {
			ids.push(id);
		},
		async idOf(email: string): Promise<string | undefined> {
			const rows = await owner`select id from "user" where email = ${email}`;
			const id = rows[0]?.id as string | undefined;
			if (id) ids.push(id);
			return id;
		},
		async cleanup(): Promise<void> {
			const doomed = emails.splice(0);
			if (doomed.length === 0 && ids.length === 0) return;
			const found =
				await owner`select id from "user" where email = any(${owner.array(doomed, 'text')})`;
			const gone = [...ids.splice(0), ...found.map((row: { id: string }) => row.id)];
			await owner`delete from audit where user_id = any(${owner.array(gone, 'uuid')})`;
			await owner`delete from "user" where email = any(${owner.array(doomed, 'text')})`;
		},
		close: () => owner.close(),
	};
}
