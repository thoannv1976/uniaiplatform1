import { MemorySecretStore, MockProvider, type ProviderConnection } from '@uniai/ai-providers';
import type { ProviderView } from '@uniai/shared';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { ProviderRuntime, ProviderUnavailableError } from './provider-runtime.js';

const view = (over: Partial<ProviderView> = {}): ProviderView => ({
  id: 'openai',
  name: 'OpenAI',
  transport: 'direct',
  enabled: true,
  fallbackOrder: 1,
  key: { configured: true, last4: 'abcd', updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: 'sa' },
  transports: ['direct'],
  keyRequired: true,
  ready: true,
  ...over,
});

function setup(env: Record<string, string> = {}) {
  const secrets = new MemorySecretStore();
  const built: ProviderConnection[] = [];
  const runtime = new ProviderRuntime(
    secrets,
    (c) => {
      built.push(c);
      return new MockProvider();
    },
    loadConfig({ GCLOUD_PROJECT: 'uniaiplatform1', FIRESTORE_DATABASE_ID: 'staging', ...env }),
  );
  return { secrets, built, runtime };
}

describe('ProviderRuntime', () => {
  it('reads the staging secret and reuses the adapter until the key changes', async () => {
    const { secrets, built, runtime } = setup();
    await secrets.addVersion('openai-api-key-staging', 'sk-one');
    await runtime.resolve(view());
    await runtime.resolve(view());
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({ apiKey: 'sk-one', transport: 'direct' });
    await secrets.addVersion('openai-api-key-staging', 'sk-two');
    await runtime.resolve(view({ key: { ...view().key, updatedAt: '2026-10-02T00:00:00.000Z' } }));
    expect(built.map((c) => c.apiKey)).toEqual(['sk-one', 'sk-two']);
  });

  it('uses Vertex AI with the project and global location, without a key', async () => {
    const { built, runtime } = setup();
    await runtime.resolve(
      view({
        id: 'gemini',
        transport: 'vertex',
        keyRequired: false,
        key: { configured: false, last4: null, updatedAt: null, updatedBy: null },
      }),
    );
    expect(built[0]).toMatchObject({
      id: 'gemini',
      transport: 'vertex',
      apiKey: null,
      project: 'uniaiplatform1',
      location: 'global',
    });
  });

  it('explains what is missing', async () => {
    const { runtime } = setup();
    await expect(
      runtime.resolve(
        view({ key: { configured: false, last4: null, updatedAt: null, updatedBy: null } }),
      ),
    ).rejects.toThrow(/Chưa nhập API key/);
    await expect(runtime.resolve(view())).rejects.toThrow(/openai-api-key-staging/);
    await expect(runtime.resolve(view({ id: 'mock', keyRequired: false }))).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    const noProject = setup({ GCLOUD_PROJECT: '' });
    await expect(
      noProject.runtime.resolve(view({ id: 'gemini', transport: 'vertex', keyRequired: false })),
    ).rejects.toThrow(/GCLOUD_PROJECT/);
  });
});
