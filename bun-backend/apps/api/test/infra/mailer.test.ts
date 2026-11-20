import { expect, test } from 'bun:test';
import { captureLogger } from '@starter/lib/testing';
import { createLogMailer } from '#src/infra/mailer.ts';

test('the log mailer logs the whole message at info, once', async () => {
	const { logger, lines } = captureLogger();
	await createLogMailer(logger).send(
		{ to: 'a@example.test', subject: 'Verify', text: 'http://x/verify?token=t' },
		AbortSignal.timeout(1000),
	);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatchObject({
		level: 30,
		to: 'a@example.test',
		subject: 'Verify',
		text: 'http://x/verify?token=t',
	});
});
