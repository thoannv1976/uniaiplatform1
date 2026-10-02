import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('opens after 3 failures for 30 s, then lets a trial through; success resets', () => {
    let now = 1_000_000;
    const cb = new CircuitBreaker(() => now);
    expect(cb.failure('openai')).toBe(false);
    expect(cb.failure('openai')).toBe(false);
    expect(cb.openFor('openai')).toBe(0);
    expect(cb.failure('openai')).toBe(true);
    expect(cb.openFor('openai')).toBe(30);
    expect(cb.openFor('gemini')).toBe(0);
    now += 30_000;
    expect(cb.openFor('openai')).toBe(0); // trial
    expect(cb.failure('openai')).toBe(true); // trial failed: open again
    expect(cb.openFor('openai')).toBe(30);
    now += 30_000;
    cb.success('openai');
    expect(cb.failure('openai')).toBe(false);
  });
});
