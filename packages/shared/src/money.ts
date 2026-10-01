/**
 * All money in the platform is an integer number of micro-USD (1 USD = 1_000_000).
 * Floating point is only allowed at the edges (display, parsing admin input).
 */
export type MicroUsd = number;

export const MICRO_PER_USD = 1_000_000;
const TOKENS_PER_MTOK = 1_000_000;

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer, got ${value}`);
  }
}

/** Parse a USD amount (e.g. from an admin form) into micro-USD, rounding half away from zero. */
export function usdToMicro(usd: number): MicroUsd {
  if (!Number.isFinite(usd)) throw new RangeError(`usd must be finite, got ${usd}`);
  const micro = Math.sign(usd) * Math.round(Math.abs(usd) * MICRO_PER_USD);
  assertSafeInteger(micro, 'micro-USD amount');
  return micro;
}

/** Convert micro-USD to USD for display only. */
export function microToUsd(micro: MicroUsd): number {
  assertSafeInteger(micro, 'micro');
  return micro / MICRO_PER_USD;
}

/**
 * Cost of `tokens` at a price expressed in micro-USD per 1M tokens.
 * Rounded up so the platform never under-charges a request.
 */
export function tokenCost(tokens: number, microPerMTok: MicroUsd): MicroUsd {
  assertSafeInteger(tokens, 'tokens');
  assertSafeInteger(microPerMTok, 'microPerMTok');
  if (tokens < 0 || microPerMTok < 0) throw new RangeError('tokens and price must be >= 0');
  const product = BigInt(tokens) * BigInt(microPerMTok);
  const divisor = BigInt(TOKENS_PER_MTOK);
  const cost = (product + divisor - 1n) / divisor;
  const result = Number(cost);
  assertSafeInteger(result, 'cost');
  return result;
}

export interface ModelPrice {
  inputPerMTok: MicroUsd;
  outputPerMTok: MicroUsd;
  cachedInputPerMTok?: MicroUsd;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

/** Total cost of a request; cached input tokens are billed at the cached rate when one is set. */
export function usageCost(usage: TokenUsage, price: ModelPrice): MicroUsd {
  const cached = usage.cachedInputTokens ?? 0;
  const cachedRate = price.cachedInputPerMTok ?? price.inputPerMTok;
  return (
    tokenCost(usage.inputTokens, price.inputPerMTok) +
    tokenCost(cached, cachedRate) +
    tokenCost(usage.outputTokens, price.outputPerMTok)
  );
}

/** Format micro-USD as a USD string, e.g. "$1.27" or "$0.0005" for tiny amounts. */
export function formatUsd(micro: MicroUsd): string {
  const usd = microToUsd(micro);
  const digits = Math.abs(usd) > 0 && Math.abs(usd) < 0.01 ? 4 : 2;
  return `$${usd.toFixed(digits)}`;
}
