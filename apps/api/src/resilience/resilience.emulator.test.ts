import type { INestApplication } from '@nestjs/common';
import { getDb, KillSwitchStore } from '@uniai/firestore';
import { createSseParser, TERMS_VERSION, type ChatStreamEvent } from '@uniai/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';
import { audit, givenUser, resetData, startApp, tokenFor } from '../test/harness.js';

let app: INestApplication;
let failing: Set<string>;
const http = () => request(app.getHttpServer());
const killSwitch = new KillSwitchStore(getDb());
const OFF = { all: false, providers: [], models: [], tiers: [], reason: '', autoBrakePercent: 100 };

async function chat(who: string, payload: Record<string, unknown>) {
  const res = await http()
    .post('/api/ai/chat')
    .set('Authorization', tokenFor(who))
    .send(payload)
    .buffer(true)
    .parse((r, cb) => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', (c: string) => (data += c));
      r.on('end', () => cb(null, data));
    });
  const raw = res.body as string;
  const events: ChatStreamEvent[] = [];
  if (res.status === 200) {
    const p = createSseParser((e) => events.push(e));
    p.push(raw);
    p.end();
  }
  const body = (res.status === 200 ? {} : JSON.parse(raw)) as { message?: string };
  return { status: res.status, body, events };
}
const metas = (events: ChatStreamEvent[]) =>
  events.flatMap((e) => (e.type === 'meta' ? [e.model.id] : []));

beforeAll(async () => {
  ({ app, failing } = await startApp());
});
afterAll(async () => {
  await app?.close();
});
beforeEach(async () => {
  await resetData();
  failing.clear();
  app.get(CircuitBreaker).reset();
  await givenUser(app, 'gv', 'user', 'active', { departmentId: 'QTKD' });
  await givenUser(app, 'ai', 'ai_admin');
  // A second economy model from another provider (Gemini over Vertex AI: no key needed).
  await http()
    .patch('/api/admin/models/gemini-3.1-flash-lite')
    .set('Authorization', tokenFor('ai'))
    .send({ status: 'active', priority: 10 })
    .expect(200);
  await http()
    .put('/api/admin/kill-switch')
    .set('Authorization', tokenFor('ai'))
    .send(OFF)
    .expect(200);
});

describe('fallback and circuit breaker', () => {
  it('moves to the equivalent model of another provider and bills the model that answered', async () => {
    failing.add('gemini');
    const res = await chat('gv', { message: 'Xin chào' });
    expect(res.status).toBe(200);
    expect(metas(res.events)).toEqual(['gemini-3.1-flash-lite', 'mock-economy']);
    expect(res.events.at(-1)).toMatchObject({ type: 'done', status: 'complete' });
    const text = res.events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');
    expect(text).toBe('[mock:mock-economy] Xin chào');

    const ledger = await getDb().collection('usageTransactions').where('uid', '==', 'gv').get();
    const byStatus = ledger.docs.map((d) => [
      d.get('modelId'),
      d.get('status'),
      d.get('fallbackFrom'),
    ]);
    expect(byStatus).toEqual(
      expect.arrayContaining([
        ['gemini-3.1-flash-lite', 'released', null],
        ['mock-economy', 'committed', 'gemini-3.1-flash-lite'],
      ]),
    );
    const meta = res.events[0];
    if (meta?.type !== 'meta') throw new Error('no meta');
    const stored = await getDb()
      .collection('conversations')
      .doc(meta.conversationId)
      .collection('messages')
      .doc(meta.messageId)
      .get();
    expect(stored.get('modelId')).toBe('mock-economy');

    const events = (await audit().list()).map((l) => l.event);
    expect(events).toEqual(
      expect.arrayContaining(['FALLBACK_USED', 'API_ERROR', 'AI_REQUEST', 'MODEL_ROUTED']),
    );
    const ai = (await audit().list()).find((l) => l.event === 'AI_REQUEST');
    expect(ai?.metadata).toMatchObject({ model: 'mock-economy', status: 'complete' });
    expect(JSON.stringify(ai)).not.toContain('Xin chào');
  });

  it('skips a provider whose circuit is open after repeated failures', async () => {
    failing.add('gemini');
    for (let i = 0; i < 3; i++) await chat('gv', { message: `Lần ${i}` });
    const res = await chat('gv', { message: 'Lần 4' });
    expect(metas(res.events)).toEqual(['mock-economy']);
    const chosen = await chat('gv', { message: 'Chọn tay', model: 'gemini-3.1-flash-lite' });
    expect(chosen.status).toBe(503);
    expect(chosen.body.message).toContain('tạm ngắt');
  });

  it('reports the error when no equivalent model exists', async () => {
    failing.add('gemini');
    failing.add('mock');
    const res = await chat('gv', { message: 'Xin chào' });
    expect(metas(res.events)).toEqual(['gemini-3.1-flash-lite', 'mock-economy']);
    expect(res.events.at(-1)).toMatchObject({ type: 'done', status: 'error' });
  });
});

describe('kill switch', () => {
  it('stops a provider, a tier or everything within 5 seconds', async () => {
    await http()
      .put('/api/admin/kill-switch')
      .set('Authorization', tokenFor('ai'))
      .send({ ...OFF, providers: ['gemini'], reason: 'Sự cố Gemini' })
      .expect(200);
    expect(metas((await chat('gv', { message: 'A' })).events)).toEqual(['mock-economy']);
    const models = await http().get('/api/ai/models').set('Authorization', tokenFor('gv'));
    expect(models.body.models.map((m: { id: string }) => m.id)).not.toContain(
      'gemini-3.1-flash-lite',
    );

    // Another instance (or the console) switches everything off: the listener picks it up.
    await killSwitch.set({ ...OFF, all: true, reason: 'Bảo trì hệ thống' }, 'sa');
    const started = Date.now();
    await expect
      .poll(async () => (await chat('gv', { message: 'B' })).status, {
        timeout: 5000,
        interval: 200,
      })
      .toBe(503);
    expect(Date.now() - started).toBeLessThan(5000);
    const refused = await chat('gv', { message: 'C' });
    expect(refused.body.message).toBe('Hệ thống AI đang tạm dừng. Lý do: Bảo trì hệ thống');

    const change = (await audit().list()).find((l) => l.target === 'settings:killSwitch');
    expect(change).toMatchObject({ event: 'ADMIN_CHANGE', actor: 'ai' });
  });

  it('validates changes and limits who may make them', async () => {
    await http()
      .put('/api/admin/kill-switch')
      .set('Authorization', tokenFor('ai'))
      .send({ ...OFF, all: true })
      .expect(400);
    await http()
      .put('/api/admin/kill-switch')
      .set('Authorization', tokenFor('gv'))
      .send(OFF)
      .expect(403);
  });
});

describe('terms of use', () => {
  it('blocks AI until the current terms are accepted', async () => {
    await givenUser(app, 'moi', 'user', 'active', { acceptTerms: false });
    const me = await http().get('/api/me').set('Authorization', tokenFor('moi'));
    expect(me.body.termsVersion).toBeNull();
    const blocked = await chat('moi', { message: 'Xin chào' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.message).toContain('Điều khoản sử dụng');
    await http()
      .post('/api/files')
      .set('Authorization', tokenFor('moi'))
      .send({ name: 'a.pdf', mime: 'application/pdf', size: 10 })
      .expect(403);

    await http()
      .post('/api/me/terms')
      .set('Authorization', tokenFor('moi'))
      .send({ version: 'cu' })
      .expect(400);
    await http()
      .post('/api/me/terms')
      .set('Authorization', tokenFor('moi'))
      .send({ version: TERMS_VERSION })
      .expect(204);
    expect((await chat('moi', { message: 'Xin chào' })).status).toBe(200);
    const accepted = (await audit().list()).find((l) => l.event === 'TERMS_ACCEPTED');
    expect(accepted).toMatchObject({ actor: 'moi', metadata: { version: TERMS_VERSION } });
  });
});
