import { describe, expect, test } from 'bun:test';
import { CircuitBreaker, CircuitOpenError } from '@starter/lib/circuit-breaker';

describe('circuit breaker', () => {
	test('opens after threshold, half-opens after timeout, closes on success', async () => {
		let now = 0;
		const breaker = new CircuitBreaker({
			failureThreshold: 2,
			resetTimeoutMs: 1000,
			now: () => now,
		});
		const fail = () => Promise.reject(new Error('503'));
		await expect(breaker.exec(fail)).rejects.toThrow('503');
		await expect(breaker.exec(fail)).rejects.toThrow('503');
		expect(breaker.state).toBe('open');
		await expect(breaker.exec(async () => 1)).rejects.toBeInstanceOf(CircuitOpenError);
		now = 1000;
		expect(await breaker.exec(async () => 1)).toBe(1);
		expect(breaker.state).toBe('closed');
	});

	test('non-failure errors do not open the circuit', async () => {
		const breaker = new CircuitBreaker({
			failureThreshold: 1,
			resetTimeoutMs: 1000,
			isFailure: () => false,
		});
		await expect(breaker.exec(() => Promise.reject(new Error('404')))).rejects.toThrow('404');
		expect(breaker.state).toBe('closed');
	});

	test('breaker stays closed on AbortError', async () => {
		const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
		for (let i = 0; i < 10; i += 1) {
			await expect(
				breaker.exec(() => Promise.reject(new DOMException('x', 'AbortError'))),
			).rejects.toThrow('x');
		}
		expect(breaker.state).toBe('closed');
	});
});
