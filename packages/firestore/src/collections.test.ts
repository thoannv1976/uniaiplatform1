import { describe, expect, it } from 'vitest';
import { COLLECTIONS } from './collections.js';
import { QUOTA_TIERS } from './seed-data.js';

describe('collections', () => {
  it('has unique collection names', () => {
    const names = Object.values(COLLECTIONS);
    expect(new Set(names).size).toBe(names.length);
  });

  it('stores quota tiers as integer micro-USD', () => {
    for (const tier of QUOTA_TIERS) {
      expect(Number.isSafeInteger(tier.monthlyBudget)).toBe(true);
      expect(Number.isSafeInteger(tier.premiumBudget)).toBe(true);
    }
  });
});
