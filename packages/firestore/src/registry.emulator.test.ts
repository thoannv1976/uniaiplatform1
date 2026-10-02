import { usageCost, usdToMicro } from '@uniai/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from './admin.js';
import { DEFAULT_MODELS } from './registry-catalog.js';
import { RegistryError, RegistryStore } from './registry.js';
import { seed } from './seed.js';
import { clearFirestoreEmulator } from './testing.js';

const db = getDb();
const registry = new RegistryStore(db);

beforeEach(async () => {
  await clearFirestoreEmulator();
  await seed(db);
});

describe('providers', () => {
  it('fall back to built-in settings and validate the transport', async () => {
    const list = await registry.listProviders();
    expect(list.map((p) => p.id)).toEqual(['openai', 'gemini', 'anthropic', 'mock']);
    expect(list.find((p) => p.id === 'openai')).toMatchObject({
      transport: 'direct',
      keyRequired: true,
      ready: false,
      key: { configured: false, last4: null },
    });
    expect(list.find((p) => p.id === 'anthropic')).toMatchObject({
      transport: 'vertex',
      keyRequired: false,
      ready: true,
    });
    await expect(registry.updateProvider('openai', { transport: 'vertex' }, 'sa')).rejects.toThrow(
      RegistryError,
    );
  });

  it('switching to direct needs a key; recording one stores only metadata', async () => {
    const { before, after } = await registry.updateProvider(
      'anthropic',
      { transport: 'direct' },
      'sa',
    );
    expect(before.transport).toBe('vertex');
    expect(after).toMatchObject({ transport: 'direct', keyRequired: true, ready: false });
    const withKey = await registry.recordKey('anthropic', 'wxyz', 'sa');
    expect(withKey).toMatchObject({
      ready: true,
      key: { configured: true, last4: 'wxyz', updatedBy: 'sa' },
    });
    const raw = (await db.collection('providers').doc('anthropic').get()).data();
    expect(JSON.stringify(raw)).not.toMatch(/sk-/);
  });
});

describe('models and prices', () => {
  it('seeds the catalogue once, with real models disabled', async () => {
    const models = await registry.listModels();
    expect(models).toHaveLength(DEFAULT_MODELS.length);
    expect(
      models
        .filter((m) => m.status === 'active')
        .map((m) => m.id)
        .sort(),
    ).toEqual(['mock-advanced', 'mock-economy']);
    const haiku = models.find((m) => m.id === 'claude-haiku-4-5');
    expect(haiku?.currentPrice).toMatchObject({
      inputPerMTok: 1_000_000,
      outputPerMTok: 5_000_000,
      cachedInputPerMTok: 100_000,
    });
    expect(await registry.seedDefaults('sa', { includeMock: true })).toEqual([]);
  });

  it('creates, updates and refuses duplicates or unknown models', async () => {
    const created = await registry.createModel(
      {
        ...DEFAULT_MODELS[0]!,
        id: 'test-model',
        price: { inputPerMTok: 1, outputPerMTok: 2, cachedInputPerMTok: null },
      },
      'ai',
    );
    expect(created).toMatchObject({
      id: 'test-model',
      updatedBy: 'ai',
      currentPrice: { inputPerMTok: 1 },
    });
    await expect(registry.createModel({ ...DEFAULT_MODELS[0]! }, 'ai')).rejects.toMatchObject({
      code: 'conflict',
    });
    const { before, after } = await registry.updateModel(
      'test-model',
      { status: 'active', tier: 'premium' },
      'ai',
    );
    expect(before.status).toBe('disabled');
    expect(after).toMatchObject({ status: 'active', tier: 'premium' });
    await expect(registry.updateModel('nope', { status: 'active' }, 'ai')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('keeps price history: new prices apply from their start, old ones stay', async () => {
    const now = new Date();
    const later = new Date(now.getTime() + 24 * 3600_000);
    await registry.addPrice(
      'claude-haiku-4-5',
      {
        inputPerMTok: usdToMicro(0.8),
        outputPerMTok: usdToMicro(4),
        cachedInputPerMTok: null,
        effectiveFrom: later.toISOString(),
      },
      'ai',
    );
    const today = await registry.getModel('claude-haiku-4-5', now);
    expect(today?.currentPrice?.inputPerMTok).toBe(1_000_000);
    expect(today?.nextPrice?.inputPerMTok).toBe(800_000);
    const tomorrow = await registry.getModel('claude-haiku-4-5', new Date(later.getTime() + 1000));
    expect(tomorrow?.currentPrice?.inputPerMTok).toBe(800_000);
    expect(await registry.listPrices('claude-haiku-4-5')).toHaveLength(2);

    // Costs are integers in micro-USD at the price in effect.
    const cost = usageCost(
      { inputTokens: 1500, outputTokens: 500, cachedInputTokens: 1000 },
      today!.currentPrice!,
    );
    expect(cost).toBe(1500 + 2500 + 100);
  });

  it('refuses back-dated prices and prices for unknown models', async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    await expect(
      registry.addPrice(
        'mock-economy',
        { inputPerMTok: 1, outputPerMTok: 1, cachedInputPerMTok: null, effectiveFrom: past },
        'ai',
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      registry.addPrice(
        'nope',
        { inputPerMTok: 1, outputPerMTok: 1, cachedInputPerMTok: null },
        'ai',
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
