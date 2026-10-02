import { describe, expect, it } from 'vitest';
import {
  createModelRequestSchema,
  maskedKey,
  needsApiKey,
  newPriceSchema,
  nextPriceAfter,
  priceAt,
  setProviderKeyRequestSchema,
  updateModelRequestSchema,
} from './models.js';

const p = (id: string, effectiveFrom: string) => ({ id, effectiveFrom });

describe('price history', () => {
  const prices = [
    p('old', '2026-01-01T00:00:00Z'),
    p('now', '2026-06-01T00:00:00Z'),
    p('later', '2026-12-01T00:00:00Z'),
  ];

  it('picks the latest price that has started', () => {
    expect(priceAt(prices, new Date('2026-07-01T00:00:00Z'))?.id).toBe('now');
    expect(priceAt(prices, new Date('2026-06-01T00:00:00Z'))?.id).toBe('now');
    expect(priceAt(prices, new Date('2025-01-01T00:00:00Z'))).toBeNull();
  });

  it('finds the next scheduled price', () => {
    expect(nextPriceAfter(prices, new Date('2026-07-01T00:00:00Z'))?.id).toBe('later');
    expect(nextPriceAfter(prices, new Date('2027-01-01T00:00:00Z'))).toBeNull();
  });
});

describe('registry schemas', () => {
  const base = {
    id: 'claude-haiku-4-5',
    providerId: 'anthropic',
    apiModelId: 'claude-haiku-4-5@20251001',
    displayName: 'Claude Haiku 4.5',
    tier: 'standard',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    capabilities: ['text', 'image', 'text'],
    price: { inputPerMTok: 1_000_000, outputPerMTok: 5_000_000 },
  };

  it('fills defaults: new models start disabled', () => {
    const parsed = createModelRequestSchema.parse(base);
    expect(parsed).toMatchObject({
      status: 'disabled',
      priority: 100,
      rateLimitPerMinute: null,
      defaultParams: {},
      notes: '',
      capabilities: ['text', 'image'],
      price: { cachedInputPerMTok: null },
    });
  });

  it('rejects fractional prices, odd ids and unknown fields', () => {
    expect(
      createModelRequestSchema.safeParse({
        ...base,
        price: { inputPerMTok: 0.5, outputPerMTok: 1 },
      }).success,
    ).toBe(false);
    expect(createModelRequestSchema.safeParse({ ...base, id: 'Has Space' }).success).toBe(false);
    expect(createModelRequestSchema.safeParse({ ...base, apiModelId: 'a/../b' }).success).toBe(
      false,
    );
    expect(updateModelRequestSchema.safeParse({ providerId: 'openai' }).success).toBe(false);
    expect(updateModelRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts ISO effective dates with an offset', () => {
    expect(
      newPriceSchema.safeParse({
        inputPerMTok: 1,
        outputPerMTok: 2,
        effectiveFrom: '2026-10-02T07:00:00+07:00',
      }).success,
    ).toBe(true);
    expect(
      newPriceSchema.safeParse({ inputPerMTok: 1, outputPerMTok: 2, effectiveFrom: 'mai' }).success,
    ).toBe(false);
  });
});

describe('provider keys', () => {
  it('only direct calls to real vendors need a key', () => {
    expect(needsApiKey('openai', 'direct')).toBe(true);
    expect(needsApiKey('anthropic', 'vertex')).toBe(false);
    expect(needsApiKey('mock', 'direct')).toBe(false);
  });

  it('validates the key shape and masks it for display', () => {
    expect(setProviderKeyRequestSchema.safeParse({ apiKey: ' sk-abcdefghijklmnopqrstu ' })).toEqual(
      { success: true, data: { apiKey: 'sk-abcdefghijklmnopqrstu' } },
    );
    expect(
      setProviderKeyRequestSchema.safeParse({ apiKey: 'sk-abc def ghi jkl mno pqr' }).success,
    ).toBe(false);
    expect(setProviderKeyRequestSchema.safeParse({ apiKey: 'short' }).success).toBe(false);
    expect(maskedKey('abcd')).toBe('…abcd');
    expect(maskedKey(null)).toBe('');
  });
});
