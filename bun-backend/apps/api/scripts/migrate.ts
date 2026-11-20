import { loadEnv } from '@starter/lib/config';
import { createLogger } from '@starter/lib/log';
import { migrateDatabase } from '@starter/db/migrate';
import { Env } from '#src/bootstrap/config.ts';

// A process entry like main.ts: `bun run db:migrate`. It is the only reader of the owner URL.
const env = loadEnv(Env, Bun.env);
const logger = createLogger({
	level: env.LOG_LEVEL,
	service: 'starter-migrate',
	environment: env.NODE_ENV,
});
const ownerUrl = env.DATABASE_MIGRATION_URL;
if (!ownerUrl) {
	console.error('DATABASE_MIGRATION_URL is not set: db:migrate needs the owner connection.');
	process.exit(1);
}

try {
	await migrateDatabase({
		ownerUrl,
		appUrl: env.DATABASE_URL,
		migrationsFolder: `${import.meta.dir}/../../../packages/db/migrations`,
		connectTimeoutS: env.DB_CONNECT_TIMEOUT_S,
		logger,
		signal: AbortSignal.timeout(env.MIGRATION_TIMEOUT_MS),
	});
	logger.info('db:migrate done');
} catch (error) {
	logger.error({ err: error }, 'db:migrate failed');
	process.exitCode = 1;
}
