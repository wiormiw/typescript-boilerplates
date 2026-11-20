import type { Logger } from '@starter/lib/log';
import type { Mailer } from '#src/infra/types.ts';

// Written once so config validates against it; B9 adds `resend`.
export const MAIL_TRANSPORTS = ['log'] as const;

/** Writes the message to the log instead of sending it: for a laptop, where the link is the point. */
export function createLogMailer(logger: Logger): Mailer {
	const log = logger.child({ component: 'mailer' });
	return {
		async send(message) {
			log.info({ to: message.to, subject: message.subject, text: message.text }, 'mail');
		},
	};
}
