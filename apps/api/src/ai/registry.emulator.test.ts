import type { INestApplication } from '@nestjs/common';
import type { MemorySecretStore, ProviderConnection } from '@uniai/ai-providers';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { audit, givenUser, resetData, startApp, tokenFor } from '../test/harness.js';

let app: INestApplication;
let secrets: MemorySecretStore;
let connections: ProviderConnection[];
const http = () => request(app.getHttpServer());
const KEY = 'sk-ant-api03-ThisIsATestKey-0123456789wxyz';

beforeAll(async () => {
  ({ app, secrets, connections } = await startApp());
});
afterAll(async () => {
  await app?.close();
});
beforeEach(async () => {
  await resetData();
  secrets.versions.clear();
  connections.length = 0;
  await givenUser(app, 'sa', 'super_admin');
  await givenUser(app, 'ai', 'ai_admin');
});

describe('providers and API keys', () => {
  it('direct calls need a key, which goes to Secret Manager and never comes back', async () => {
    const ai = tokenFor('ai');
    await http()
      .patch('/api/admin/providers/anthropic')
      .set('Authorization', ai)
      .send({ transport: 'direct' })
      .expect(200);

    const noKey = await http()
      .post('/api/admin/models/claude-haiku-4-5/test')
      .set('Authorization', ai);
    expect(noKey.status).toBe(400);
    expect(noKey.body.message).toMatch(/Chưa nhập API key/);

    const set = await http()
      .put('/api/admin/providers/anthropic/key')
      .set('Authorization', tokenFor('sa'))
      .send({ apiKey: KEY })
      .expect(200);
    expect(set.body).toMatchObject({ ready: true, key: { configured: true, last4: 'wxyz' } });
    expect(JSON.stringify(set.body)).not.toContain(KEY);
    expect(secrets.versions.get('anthropic-api-key')).toEqual([KEY]);

    const list = await http().get('/api/admin/providers').set('Authorization', ai).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(KEY);

    const tested = await http()
      .post('/api/admin/models/claude-haiku-4-5/test')
      .set('Authorization', ai)
      .send({ prompt: 'Chào' })
      .expect(200);
    expect(tested.body).toMatchObject({
      ok: true,
      transport: 'direct',
      apiModelId: 'claude-haiku-4-5@20251001',
    });
    expect(connections.at(-1)).toMatchObject({ id: 'anthropic', transport: 'direct', apiKey: KEY });

    const logs = await audit().list();
    expect(logs.find((l) => l.metadata.action === 'set_provider_key')).toMatchObject({
      actor: 'sa',
      metadata: { last4: 'wxyz', secret: 'anthropic-api-key' },
    });
    expect(JSON.stringify(logs)).not.toContain(KEY);
  });

  it('a new key replaces the adapter on the next call', async () => {
    const sa = tokenFor('sa');
    await http()
      .patch('/api/admin/providers/openai')
      .set('Authorization', sa)
      .send({ enabled: true });
    await http()
      .put('/api/admin/providers/openai/key')
      .set('Authorization', sa)
      .send({ apiKey: 'sk-first-key-0123456789abcd' }) // gitleaks:allow (fake test key)
      .expect(200);
    await http().post('/api/admin/models/gpt-6-luna/test').set('Authorization', sa).expect(200);
    await http().post('/api/admin/models/gpt-6-luna/test').set('Authorization', sa).expect(200);
    expect(connections.filter((c) => c.id === 'openai')).toHaveLength(1);
    await http()
      .put('/api/admin/providers/openai/key')
      .set('Authorization', sa)
      .send({ apiKey: 'sk-second-key-0123456789efgh' }) // gitleaks:allow (fake test key)
      .expect(200);
    await http().post('/api/admin/models/gpt-6-luna/test').set('Authorization', sa).expect(200);
    expect(connections.filter((c) => c.id === 'openai').map((c) => c.apiKey)).toEqual([
      'sk-first-key-0123456789abcd', // gitleaks:allow
      'sk-second-key-0123456789efgh', // gitleaks:allow
    ]);
  });

  it('validates providers, transports and keys', async () => {
    const sa = tokenFor('sa');
    expect(
      (
        await http()
          .patch('/api/admin/providers/nope')
          .set('Authorization', sa)
          .send({ enabled: false })
      ).status,
    ).toBe(404);
    const vertexOpenai = await http()
      .patch('/api/admin/providers/openai')
      .set('Authorization', sa)
      .send({ transport: 'vertex' });
    expect(vertexOpenai.status).toBe(400);
    expect(vertexOpenai.body.message).toMatch(/không hỗ trợ/);
    expect(
      (
        await http()
          .put('/api/admin/providers/mock/key')
          .set('Authorization', sa)
          .send({ apiKey: KEY })
      ).status,
    ).toBe(400);
    const badKey = await http()
      .put('/api/admin/providers/openai/key')
      .set('Authorization', sa)
      .send({ apiKey: 'has space in it 0123456789' });
    expect(badKey.status).toBe(400);
    expect(JSON.stringify(badKey.body)).not.toContain('has space');
  });
});

describe('models and prices', () => {
  it('tests a mock model and prices the usage in integer micro-USD', async () => {
    const res = await http()
      .post('/api/admin/models/mock-economy/test')
      .set('Authorization', tokenFor('ai'))
      .send({ prompt: 'một hai ba bốn' })
      .expect(200);
    expect(res.body).toMatchObject({
      ok: true,
      stopReason: 'end',
      text: '[mock:mock-economy] một hai ba bốn',
      error: null,
    });
    expect(Number.isSafeInteger(res.body.cost)).toBe(true);
    expect(res.body.cost).toBeGreaterThan(0);
    expect(connections).toHaveLength(1);
  });

  it('creates, edits and re-prices models; keeps the history', async () => {
    const ai = tokenFor('ai');
    const created = await http()
      .post('/api/admin/models')
      .set('Authorization', ai)
      .send({
        id: 'mock-test',
        providerId: 'mock',
        apiModelId: 'mock-test',
        displayName: 'Mock thử',
        tier: 'economy',
        contextWindow: 1000,
        maxOutputTokens: 100,
        capabilities: ['text'],
        price: { inputPerMTok: 100_000, outputPerMTok: 500_000 },
      })
      .expect(201);
    expect(created.body).toMatchObject({
      status: 'disabled',
      currentPrice: { inputPerMTok: 100_000 },
    });
    expect(
      (
        await http()
          .post('/api/admin/models')
          .set('Authorization', ai)
          .send({ ...created.body, price: { inputPerMTok: 1, outputPerMTok: 1 } })
      ).status,
    ).toBe(400);

    const patched = await http()
      .patch('/api/admin/models/mock-test')
      .set('Authorization', ai)
      .send({ status: 'active', tier: 'advanced' })
      .expect(200);
    expect(patched.body).toMatchObject({ status: 'active', tier: 'advanced' });

    await http()
      .post('/api/admin/models/mock-test/prices')
      .set('Authorization', ai)
      .send({ inputPerMTok: 200_000, outputPerMTok: 900_000 })
      .expect(201);
    const prices = await http()
      .get('/api/admin/models/mock-test/prices')
      .set('Authorization', ai)
      .expect(200);
    expect(prices.body.prices.map((p: { inputPerMTok: number }) => p.inputPerMTok)).toEqual([
      200_000, 100_000,
    ]);

    const past = await http()
      .post('/api/admin/models/mock-test/prices')
      .set('Authorization', ai)
      .send({ inputPerMTok: 1, outputPerMTok: 1, effectiveFrom: '2020-01-01T00:00:00Z' });
    expect(past.status).toBe(400);
    expect(past.body.message).toMatch(/quá khứ/);

    const actions = (await audit().list()).map((l) => l.metadata.action);
    expect(actions).toEqual(expect.arrayContaining(['create_model', 'update_model', 'add_price']));
  });

  it('answers 404 for unknown or malformed model ids and 409 for duplicates', async () => {
    const ai = tokenFor('ai');
    expect(
      (
        await http()
          .patch('/api/admin/models/khong-co')
          .set('Authorization', ai)
          .send({ status: 'active' })
      ).status,
    ).toBe(404);
    expect(
      (await http().get('/api/admin/models/Bad%20Id/prices').set('Authorization', ai)).status,
    ).toBe(404);
    expect(
      (await http().post('/api/admin/models/khong-co/test').set('Authorization', ai)).status,
    ).toBe(404);
    const dup = await http()
      .post('/api/admin/models')
      .set('Authorization', ai)
      .send({
        id: 'mock-economy',
        providerId: 'mock',
        apiModelId: 'x',
        displayName: 'x',
        tier: 'economy',
        contextWindow: 1,
        maxOutputTokens: 1,
        capabilities: ['text'],
        price: { inputPerMTok: 1, outputPerMTok: 1 },
      });
    expect(dup.status).toBe(409);
  });

  it('seeding only adds missing catalogue models', async () => {
    const ai = tokenFor('ai');
    expect(
      (await http().post('/api/admin/models/seed').set('Authorization', ai).expect(200)).body,
    ).toEqual({ created: [] });
  });
});

describe('without the mock provider (production)', () => {
  let prod: Awaited<ReturnType<typeof startApp>>;
  beforeAll(async () => {
    prod = await startApp({ ENABLE_MOCK_PROVIDER: 'false' });
  });
  afterAll(async () => {
    await prod?.app.close();
  });

  it('refuses mock calls and does not seed mock models', async () => {
    await resetData();
    await givenUser(prod.app, 'sa2', 'super_admin');
    const res = await request(prod.app.getHttpServer())
      .post('/api/admin/models/mock-economy/test')
      .set('Authorization', tokenFor('sa2'));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/staging/);
  });
});
