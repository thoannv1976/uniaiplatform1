import { describe, expect, it } from 'vitest';
import { redactSecrets } from './errors.js';
import { MockProvider } from './mock.js';
import { probe } from './probe.js';
import { GcpSecretStore, MemorySecretStore, secretNameFor, SecretStoreError } from './secrets.js';
import { fakeGoogleAuth, replay } from './testing/recorded-http.js';

describe('secret names', () => {
  it('keeps staging keys apart from production', () => {
    expect(secretNameFor('openai')).toBe('openai-api-key');
    expect(secretNameFor('openai', '(default)')).toBe('openai-api-key');
    expect(secretNameFor('anthropic', 'staging')).toBe('anthropic-api-key-staging');
  });
});

describe('GcpSecretStore', () => {
  const store = (status: number, body: unknown) => {
    const http = replay({ status, body: JSON.stringify(body), contentType: 'application/json' });
    return {
      http,
      store: new GcpSecretStore('uniaiplatform1', {
        authClient: fakeGoogleAuth(),
        fetch: http.fetch,
      }),
    };
  };

  it('adds a version with the base64 payload and the service account token', async () => {
    const { http, store: s } = store(200, { name: 'v1' });
    await s.addVersion('openai-api-key-staging', 'sk-secret-value');
    const req = http.requests[0]!;
    expect(req.url).toBe(
      'https://secretmanager.googleapis.com/v1/projects/uniaiplatform1/secrets/openai-api-key-staging:addVersion',
    );
    expect(req.method).toBe('POST');
    expect(req.headers.get('authorization')).toBe('Bearer ya29.test-token');
    expect(req.body).toEqual({
      payload: { data: Buffer.from('sk-secret-value').toString('base64') },
    });
  });

  it('reads the latest version, and null when there is none', async () => {
    const data = Buffer.from('sk-secret-value').toString('base64');
    expect(await store(200, { payload: { data } }).store.accessLatest('openai-api-key')).toBe(
      'sk-secret-value',
    );
    expect(
      await store(404, { error: { code: 404 } }).store.accessLatest('openai-api-key'),
    ).toBeNull();
  });

  it('reports permission errors without the value', async () => {
    const err = await store(403, { error: { code: 403 } })
      .store.addVersion('openai-api-key', 'sk-secret-value')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretStoreError);
    expect((err as Error).message).not.toContain('sk-secret-value');
  });

  it('refuses names that could escape the secret path', async () => {
    await expect(store(200, {}).store.accessLatest('../x')).rejects.toThrow(/không hợp lệ/);
  });
});

describe('MemorySecretStore', () => {
  it('returns the latest version', async () => {
    const s = new MemorySecretStore();
    expect(await s.accessLatest('k')).toBeNull();
    await s.addVersion('k', 'a');
    await s.addVersion('k', 'b');
    expect(await s.accessLatest('k')).toBe('b');
  });
});

describe('redactSecrets', () => {
  it('hides keys and tokens', () => {
    const out = redactSecrets(
      'key sk-proj-AbCdEf0123456789 and sk-ant-api03-xyz123456 AIzaSyA-1234567890abcdefghijkl ya29.a0Abc Bearer abc.def',
    );
    expect(out).not.toMatch(/sk-proj|sk-ant-api|AIzaSy|ya29\.a0|abc\.def/);
  });
});

describe('probe', () => {
  it('collects text, usage and stop reason', async () => {
    const r = await probe(new MockProvider(), {
      model: 'mock-economy',
      messages: [{ role: 'user', content: 'Xin chào' }],
      maxOutputTokens: 100,
    });
    expect(r).toMatchObject({
      text: '[mock:mock-economy] Xin chào',
      stopReason: 'end',
      error: null,
      usage: { inputTokens: 2, cachedInputTokens: 0 },
    });
  });

  it('reports a timeout', async () => {
    const r = await probe(
      new MockProvider({ chunkDelayMs: 200 }),
      { model: 'm', messages: [{ role: 'user', content: 'a b c d' }], maxOutputTokens: 100 },
      50,
    );
    expect(r.error?.code).toBe('timeout');
  });
});
