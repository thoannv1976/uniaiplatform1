import { describe, expect, it } from 'vitest';
import { formatUsd, microToUsd, tokenCost, usageCost, usdToMicro } from './money.js';

describe('usdToMicro / microToUsd', () => {
  it('converts whole and fractional dollars exactly', () => {
    expect(usdToMicro(2)).toBe(2_000_000);
    expect(usdToMicro(0.4225)).toBe(422_500);
    expect(usdToMicro(0.1 + 0.2)).toBe(300_000);
    expect(microToUsd(1_270_000)).toBe(1.27);
  });

  it('rejects non-finite input', () => {
    expect(() => usdToMicro(Number.NaN)).toThrow(RangeError);
    expect(() => microToUsd(1.5)).toThrow(RangeError);
  });
});

describe('tokenCost', () => {
  it('prices 1M tokens at the per-MTok rate', () => {
    expect(tokenCost(1_000_000, usdToMicro(2))).toBe(2_000_000);
  });

  it('rounds partial micro-dollars up', () => {
    // 1 token at $0.10/MTok = 0.1 micro-USD -> charged 1 micro-USD
    expect(tokenCost(1, usdToMicro(0.1))).toBe(1);
    expect(tokenCost(0, usdToMicro(0.1))).toBe(0);
  });

  it('matches the spec example: 1,820 in + 642 out on an economy model', () => {
    const cost = usageCost(
      { inputTokens: 1_820, outputTokens: 642 },
      { inputPerMTok: usdToMicro(0.1), outputPerMTok: usdToMicro(0.5) },
    );
    // 182 + 321 micro-USD = $0.000503
    expect(cost).toBe(503);
    expect(formatUsd(cost)).toBe('$0.0005');
  });

  it('bills cached input at the cached rate when present', () => {
    const cost = usageCost(
      { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 },
      { inputPerMTok: 2_000_000, outputPerMTok: 10_000_000, cachedInputPerMTok: 200_000 },
    );
    expect(cost).toBe(2_200_000);
  });

  it('rejects negative or fractional inputs', () => {
    expect(() => tokenCost(-1, 1)).toThrow(RangeError);
    expect(() => tokenCost(1.5, 1)).toThrow(RangeError);
  });
});

describe('formatUsd', () => {
  it('uses two decimals for normal amounts', () => {
    expect(formatUsd(1_270_000)).toBe('$1.27');
    expect(formatUsd(0)).toBe('$0.00');
  });
});
