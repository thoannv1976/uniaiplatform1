import { Injectable } from '@nestjs/common';

/** Consecutive retryable failures that open a provider's circuit. */
export const CIRCUIT_FAILURES = 3;
/** How long an open circuit refuses requests before one trial request is let through. */
export const CIRCUIT_OPEN_MS = 30_000;

interface State {
  failures: number;
  openUntil: number;
}

/**
 * In-memory circuit breaker per provider (spec 8.8). Each API instance keeps its own: a
 * provider failing repeatedly is skipped for CIRCUIT_OPEN_MS, then given one trial.
 */
@Injectable()
export class CircuitBreaker {
  private readonly states = new Map<string, State>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Seconds until the circuit closes again, or 0 when requests may go through. */
  openFor(provider: string): number {
    const s = this.states.get(provider);
    if (!s || s.openUntil <= this.now()) return 0;
    return Math.ceil((s.openUntil - this.now()) / 1000);
  }

  /** Forgets every failure (tests, or after an operator fixed a provider). */
  reset(): void {
    this.states.clear();
  }

  success(provider: string): void {
    this.states.delete(provider);
  }

  /** A retryable failure (429, 5xx, timeout). Returns true when this opened the circuit. */
  failure(provider: string): boolean {
    const s = this.states.get(provider) ?? { failures: 0, openUntil: 0 };
    s.failures += 1;
    const opened = s.failures >= CIRCUIT_FAILURES && s.openUntil <= this.now();
    if (opened) s.openUntil = this.now() + CIRCUIT_OPEN_MS;
    this.states.set(provider, s);
    return opened;
  }
}
