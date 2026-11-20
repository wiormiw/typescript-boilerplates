import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { MeView, SessionTokenView } from '@starter/contracts';
import { eq } from 'drizzle-orm';
import { asUser, userSettings } from '@starter/db';
import { loadEnv } from '@starter/lib/config';
import { createLogger } from '@starter/lib/log';
import { ok } from '@starter/lib/result';
import { recordSpans } from '@starter/lib/testing';
import { systemClock } from '@starter/lib/time';
import { Env } from '#src/bootstrap/config.ts';
import { buildContainer } from '#src/bootstrap/container.ts';
import { start } from '#src/bootstrap/runtime.ts';
import type { MailMessage } from '#src/infra/types.ts';
import { challengeOf } from '#src/modules/auth/use-cases/exchange-native-code.ts';
import { testUsers } from './support/auth.ts';
import { memoryRateLimit } from './support/rate-limit.ts';
import {
	appDatabaseUrl,
	isMigrated,
	isPostgresReachable,
	isValkeyReachable,
	ownerDatabaseUrl,
	valkeyUrl,
} from './support/infra.ts';

const live =
	(await isPostgresReachable()) &&
	(await isMigrated(ownerDatabaseUrl)) &&
	(await isValkeyReachable());
const maybe = live ? describe : describe.skip;

const users = testUsers('e2e');
const { owner } = users;
const password = 'correct horse 1';
const secrets: string[] = [];
// A leak may carry the signed value, its decoded form or only the part before the signature.
const addSecret = (value: string) => {
	for (const form of [value, decodeURIComponent(value), value.split('.')[0] ?? '']) {
		if (form !== '') secrets.push(form);
	}
};
const email = () => users.email();

// Telemetry stays 'off': Telemetry.start() would register a second global provider (trap 4), so
// the spans come from recordSpans(), which the container's tracer calls reach through the global API.
const env = loadEnv(Env, {
	DATABASE_URL: appDatabaseUrl,
	VALKEY_URL: valkeyUrl,
	AUTH_SECRET: 'e'.repeat(32),
	AUTH_BASE_URL: 'http://127.0.0.1:4600',
	SIGNUP_ENABLED: 'true',
	OBSERVABILITY_LEVEL: 'off',
	LOG_LEVEL: 'trace',
});

const spans = recordSpans();
const logText: string[] = [];
const mail: MailMessage[] = [];

// Overrides take values and run before any get(): a capturing mailer, a logger that writes to
// memory, and rate-limit buckets of this run's own, so repeated runs never share a limit.
const container = buildContainer(env)
	.override('rateLimit', memoryRateLimit(systemClock))
	.override('mailer', {
		async send(message) {
			mail.push(message);
		},
	})
	.override(
		'logger',
		createLogger({
			level: 'trace',
			service: 'e2e',
			environment: 'test',
			destination: { write: (line: string) => void logText.push(line) },
		}),
	);

const started = live ? await start(container) : undefined;
const app = started?.app;
const request = (path: string, init: RequestInit = {}) => {
	if (!app) throw new Error('not started');
	return app.request(path, init);
};

const json = (body: unknown): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const signUp = (address: string) =>
	request('/auth/sign-up/email', json({ email: address, password, name: 'E2E' }));
const signIn = (address: string) =>
	request('/auth/sign-in/email', json({ email: address, password }));
const userId = (address: string) => users.idOf(address);

async function mailFor(address: string): Promise<MailMessage> {
	for (let i = 0; i < 40; i++) {
		const found = mail.find((m) => m.to === address);
		if (found) return found;
		await Bun.sleep(25);
	}
	throw new Error('no mail captured');
}

beforeAll(() => {
	spans.reset();
});

afterAll(async () => {
	await users.cleanup();
	await started?.resources[Symbol.asyncDispose]();
	await container.dispose();
	await users.close();
});

maybe('auth, end to end through the real app', () => {
	test('sign-up to deletion', async () => {
		const address = email();

		expect((await signUp(address)).status).toBe(200);

		expect((await signIn(address)).status).toBe(403);

		const link = (await mailFor(address)).text.match(
			/https?:\/\/\S+\/auth\/verify-email\?\S+/,
		)?.[0];
		expect(link).toBeString();
		const verifyUrl = new URL(link ?? '');
		const verified = await request(verifyUrl.pathname + verifyUrl.search);
		expect(verified.status).toBeLessThan(400);
		addSecret(verifyUrl.searchParams.get('token') ?? '');

		const signedIn = await signIn(address);
		expect(signedIn.status).toBe(200);
		const token = signedIn.headers.get('set-auth-token') ?? '';
		expect(token).not.toBe('');
		const raw = ((await signedIn.json()) as { token?: string }).token;
		expect(raw).toBeString();
		addSecret(raw ?? '');
		addSecret(token);

		const me = await request('/me', { headers: bearer(token) });
		expect(me.status).toBe(200);
		const view = v.parse(MeView, await me.json());
		expect(view.settings.timezone).toBe('Asia/Jakarta');
		expect(view.user.email).toBe(address);
		const id = view.user.id;
		users.track(id);

		const patched = await request('/me/settings', {
			method: 'PATCH',
			headers: { ...bearer(token), 'content-type': 'application/json' },
			body: JSON.stringify({ timezone: 'Asia/Tokyo' }),
		});
		expect(patched.status).toBe(200);
		const after = await request('/me', { headers: bearer(token) });
		expect(v.parse(MeView, await after.json()).settings.timezone).toBe('Asia/Tokyo');

		// The native exchange against the real better-auth: Google cannot be driven, but everything
		// after it can. The grant goes into the container's real (Valkey) code store.
		const verifier = `${Bun.randomUUIDv7()}${Bun.randomUUIDv7()}`.replaceAll('-', '');
		const code = `code-${Bun.randomUUIDv7()}`;
		addSecret(verifier);
		addSecret(code);
		await container
			.get('authCodes')
			.putCode(
				code,
				{ sessionToken: token, codeChallenge: challengeOf(verifier), userId: id },
				60,
				AbortSignal.timeout(2000),
			);
		const exchanged = await request('/auth/native/exchange', {
			...json({ code, code_verifier: verifier }),
		});
		expect(exchanged.status).toBe(200);
		const grant = v.parse(SessionTokenView, await exchanged.json());
		expect(grant.user.id).toBe(id);
		addSecret(grant.token);
		expect((await request('/me', { headers: bearer(grant.token) })).status).toBe(200);
		// One try only.
		expect(
			(await request('/auth/native/exchange', json({ code, code_verifier: verifier }))).status,
		).toBe(400);

		const signedOut = await request('/me/sessions', { method: 'DELETE', headers: bearer(token) });
		expect(signedOut.status).toBe(204);
		expect((await request('/me', { headers: bearer(token) })).status).toBe(401);

		const again = await signIn(address);
		expect(again.status).toBe(200);
		const second = again.headers.get('set-auth-token') ?? '';
		addSecret(second);
		addSecret(((await again.json()) as { token?: string }).token ?? '');
		const deleted = await request('/me', {
			method: 'DELETE',
			headers: { ...bearer(second), 'content-type': 'application/json' },
			body: JSON.stringify({ password }),
		});
		expect(deleted.status).toBe(204);

		for (const table of ['user', 'session', 'account', 'user_settings']) {
			const column = table === 'user' ? 'id' : 'user_id';
			const rows = await owner.unsafe(`select 1 from "${table}" where ${column} = $1`, [id]);
			expect(rows).toHaveLength(0);
		}
		const audits = await owner`select action, ip from audit where user_id = ${id}`;
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ action: 'account_deleted', ip: null });
	});

	test("one user never reads another user's settings", async () => {
		const [a, b] = [email(), email()];
		for (const address of [a, b]) expect((await signUp(address)).status).toBe(200);
		const [idA, idB] = [await userId(a), await userId(b)];
		expect(idA).toBeString();
		expect(idB).toBeString();

		const database = container.get('database');
		const read = (who: string) =>
			asUser(
				database,
				{ userId: who, signal: AbortSignal.timeout(5000), operation: 'e2e.settings' },
				async (tx) => ok(await tx.select().from(userSettings)),
			);
		const asA = await read(idA ?? '');
		expect(asA.ok && asA.value.map((row) => row.userId)).toEqual([idA ?? '']);
		const bRow = await asUser(
			database,
			{ userId: idA ?? '', signal: AbortSignal.timeout(5000), operation: 'e2e.settings.other' },
			async (tx) =>
				ok(
					await tx
						.select()
						.from(userSettings)
						.where(eq(userSettings.userId, idB ?? '')),
				),
		);
		expect(bRow.ok && bRow.value).toHaveLength(0);
	});

	test('no secret reached the logs or the spans', () => {
		const everything = logText.join('\n') + JSON.stringify(spans.spans().map(spanView));
		expect(secrets.length).toBeGreaterThanOrEqual(5);
		expect(logText.length).toBeGreaterThan(0);
		expect(spans.spans().length).toBeGreaterThan(0);
		for (const secret of secrets) {
			expect(secret).not.toBe('');
			expect(everything.includes(secret)).toBe(false);
		}
	});
});

function spanView(span: ReturnType<typeof spans.spans>[number]) {
	return {
		name: span.name,
		attributes: span.attributes,
		events: span.events,
		status: span.status,
	};
}
