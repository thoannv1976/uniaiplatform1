import { MemorySecretStore, MockProvider, type ProviderConnection } from '@uniai/ai-providers';
import { getDb, RegistryStore } from '@uniai/firestore';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetData } from '../test/harness.js';
import { smoke } from './smoke-providers.js';

const registry = new RegistryStore(getDb());

beforeEach(async () => {
  await resetData();
});

describe('ops:smoke-providers', () => {
  it('calls the selected models, prices the usage and reports missing keys', async () => {
    const secrets = new MemorySecretStore();
    const built: ProviderConnection[] = [];
    const rows = await smoke({
      registry,
      secrets,
      project: 'uniaiplatform1',
      location: 'global',
      databaseId: 'staging',
      models: ['claude-haiku-4-5', 'gpt-6-luna', 'mock-economy'],
      includeDisabled: false,
      prompt: 'Xin chào',
      factory: (c) => {
        built.push(c);
        return new MockProvider();
      },
    });
    expect(rows.map((r) => [r.model, r.route, r.ok])).toEqual([
      ['claude-haiku-4-5', 'anthropic/vertex', true],
      ['gpt-6-luna', 'openai/direct', false],
    ]);
    expect(rows[0]?.cost).toMatch(/µUSD/);
    expect(rows[1]?.detail).toMatch(/openai-api-key-staging/);
    expect(built).toEqual([
      expect.objectContaining({
        id: 'anthropic',
        transport: 'vertex',
        project: 'uniaiplatform1',
        location: 'global',
      }),
    ]);
  });

  it('only tries active models unless asked otherwise', async () => {
    const opts = {
      registry,
      secrets: new MemorySecretStore(),
      project: 'p',
      location: 'global',
      databaseId: '(default)',
      models: [],
      prompt: 'x',
      factory: () => new MockProvider(),
    };
    expect(await smoke({ ...opts, includeDisabled: false })).toEqual([]);
    expect((await smoke({ ...opts, includeDisabled: true })).length).toBe(6);
  });
});
