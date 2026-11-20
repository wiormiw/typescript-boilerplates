import { untilAborted } from '@starter/lib/abort';
import type { AuthCodeStore } from '#src/infra/types.ts';
import type { Valkey } from '#src/infra/valkey.ts';

const FLOW_PREFIX = 'auth:native:flow:';
const CODE_PREFIX = 'auth:native:code:';

/**
 * Native sign-in state in Valkey. GETDEL makes a take atomic: two requests with one code cannot
 * both win. A value that fails to parse is treated as absent (it was already deleted).
 */
export function createAuthCodeStore(valkey: Pick<Valkey, 'command'>): AuthCodeStore {
	const { command } = valkey;

	async function put(key: string, value: unknown, ttlS: number, signal: AbortSignal) {
		await untilAborted(
			command.send('SET', [key, JSON.stringify(value), 'EX', String(ttlS)]),
			signal,
		);
	}

	async function take<T>(key: string, signal: AbortSignal): Promise<T | undefined> {
		const raw: unknown = await untilAborted(command.send('GETDEL', [key]), signal);
		if (typeof raw !== 'string') return undefined;
		try {
			return JSON.parse(raw) as T;
		} catch {
			return undefined;
		}
	}

	return {
		putFlow: (id, flow, ttlS, signal) => put(FLOW_PREFIX + id, flow, ttlS, signal),
		takeFlow: (id, signal) => take(FLOW_PREFIX + id, signal),
		putCode: (code, grant, ttlS, signal) => put(CODE_PREFIX + code, grant, ttlS, signal),
		takeCode: (code, signal) => take(CODE_PREFIX + code, signal),
	};
}
