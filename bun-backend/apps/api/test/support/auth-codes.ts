import type { Clock } from '@starter/lib/time';
import type { AuthCodeStore } from '#src/infra/types.ts';

/** An in-memory store with the Valkey one's semantics: expiry on read, take removes. */
export function memoryAuthCodes(clock: Clock): AuthCodeStore {
	const entries = new Map<string, { value: unknown; expiresAtMs: number }>();

	function put(key: string, value: unknown, ttlS: number) {
		entries.set(key, { value, expiresAtMs: clock.now().epochMilliseconds + ttlS * 1000 });
	}
	function take<T>(key: string): T | undefined {
		const entry = entries.get(key);
		entries.delete(key);
		if (!entry || entry.expiresAtMs <= clock.now().epochMilliseconds) return undefined;
		return entry.value as T;
	}

	return {
		putFlow: async (id, flow, ttlS) => put(`flow:${id}`, flow, ttlS),
		takeFlow: async (id) => take(`flow:${id}`),
		putCode: async (code, grant, ttlS) => put(`code:${code}`, grant, ttlS),
		takeCode: async (code) => take(`code:${code}`),
	};
}
