import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { NormalizedChatRequest } from '@uniai/ai-providers';
import { ConversationStore, getDb, RegistryStore, UsageStore } from '@uniai/firestore';
import { createSseParser, DEFAULT_SYSTEM_PROMPT, type ChatStreamEvent } from '@uniai/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { givenUser, resetData, startApp, tokenFor } from '../test/harness.js';

let app: INestApplication;
let requests: NormalizedChatRequest[];
const http_ = () => request(app.getHttpServer());
const usage = new UsageStore(getDb());
const conversations = new ConversationStore(getDb());

function parse(text: string): ChatStreamEvent[] {
  const events: ChatStreamEvent[] = [];
  const parser = createSseParser((e) => events.push(e));
  parser.push(text);
  parser.end();
  return events;
}

/** POST /api/ai/chat; returns status, raw body and parsed events. */
async function chat(who: string, body: Record<string, unknown>) {
  const res = await http_()
    .post('/api/ai/chat')
    .set('Authorization', tokenFor(who))
    .send(body)
    .buffer(true)
    .parse((r, cb) => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', (c: string) => (data += c));
      r.on('end', () => cb(null, data));
    });
  const raw = res.body as string;
  return {
    status: res.status,
    headers: res.headers,
    raw,
    events: res.status === 200 ? parse(raw) : [],
  };
}

beforeAll(async () => {
  ({ app, requests } = await startApp());
  await app.listen(0, '127.0.0.1');
});
afterAll(async () => {
  await app?.close();
});
beforeEach(async () => {
  await resetData();
  requests.length = 0;
  await givenUser(app, 'gv', 'user', 'active', { departmentId: 'KTQT-KTVM' });
  await givenUser(app, 'ai', 'ai_admin');
});

describe('POST /api/ai/chat', () => {
  it('streams an AUTO answer, stores the turn and settles the cost in the ledger', async () => {
    const { status, headers, events } = await chat('gv', { message: 'Xin chào thầy cô' });
    expect(status).toBe(200);
    expect(headers['content-type']).toContain('text/event-stream');
    const meta = events[0];
    expect(meta).toMatchObject({ type: 'meta', model: { id: 'mock-economy', tier: 'economy' } });
    const text = events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');
    expect(text).toBe('[mock:mock-economy] Xin chào thầy cô');
    const done = events.at(-1);
    expect(done).toMatchObject({ type: 'done', status: 'complete', stopReason: 'end' });
    if (done?.type !== 'done' || meta?.type !== 'meta') throw new Error('unexpected events');
    expect(Number.isSafeInteger(done.cost)).toBe(true);

    expect(requests[0]?.messages).toEqual([
      { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
      { role: 'user', content: 'Xin chào thầy cô' },
    ]);

    const detail = await http_()
      .get(`/api/conversations/${meta.conversationId}`)
      .set('Authorization', tokenFor('gv'))
      .expect(200);
    expect(detail.body.conversation).toMatchObject({ title: 'Xin chào thầy cô', messageCount: 2 });
    expect(
      detail.body.messages.map((m: { role: string; status: string; cost: number | null }) => [
        m.role,
        m.status,
        m.cost,
      ]),
    ).toEqual([
      ['user', 'complete', null],
      ['assistant', 'complete', done.cost],
    ]);

    const ledger = await usage.listForUser('gv');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      status: 'committed',
      outcome: 'complete',
      modelId: 'mock-economy',
      totalCost: done.cost,
      departmentPath: ['FTU', 'KTQT', 'KTQT-KTVM'],
      conversationId: meta.conversationId,
      messageId: meta.messageId,
    });
    const l = ledger[0]!;
    expect(l.costInput + l.costCachedInput + l.costOutput).toBe(l.totalCost);
  });

  it('continues a conversation with its history', async () => {
    const first = await chat('gv', { message: 'Câu một' });
    const meta = first.events[0];
    if (meta?.type !== 'meta') throw new Error('no meta');
    await chat('gv', {
      message: 'Câu hai',
      conversationId: meta.conversationId,
      model: 'mock-advanced',
    });
    expect(requests[1]?.model).toBe('mock-advanced');
    expect(requests[1]?.messages.slice(1)).toEqual([
      { role: 'user', content: 'Câu một' },
      { role: 'assistant', content: '[mock:mock-economy] Câu một' },
      { role: 'user', content: 'Câu hai' },
    ]);
  });

  it('keeps conversations private and validates requests before streaming', async () => {
    const mine = await chat('gv', { message: 'Riêng tư' });
    const meta = mine.events[0];
    if (meta?.type !== 'meta') throw new Error('no meta');
    const other = await chat('ai', { message: 'xem trộm', conversationId: meta.conversationId });
    expect(other.status).toBe(404);
    expect(
      (
        await http_()
          .get(`/api/conversations/${meta.conversationId}`)
          .set('Authorization', tokenFor('ai'))
      ).status,
    ).toBe(404);
    expect((await chat('gv', { message: '' })).status).toBe(400);
    expect((await chat('gv', { message: 'x', model: 'khong-co' })).status).toBe(400);
  });

  it('premium models are refused to regular users', async () => {
    const registry = new RegistryStore(getDb());
    await registry.createModel(
      {
        id: 'mock-premium',
        providerId: 'mock',
        apiModelId: 'mock-premium',
        displayName: 'Mock Premium',
        tier: 'premium',
        status: 'active',
        contextWindow: 1000,
        maxOutputTokens: 100,
        capabilities: ['text'],
        priority: 100,
        rateLimitPerMinute: null,
        defaultParams: {},
        notes: '',
        price: { inputPerMTok: 1, outputPerMTok: 1, cachedInputPerMTok: null },
      },
      'test',
    );
    // The registry is cached for up to 30 s; a fresh app sees the new model at once.
    const fresh = await startApp();
    try {
      const options = await request(fresh.app.getHttpServer())
        .get('/api/ai/models')
        .set('Authorization', tokenFor('gv'))
        .expect(200);
      expect(options.body.models.map((m: { id: string }) => m.id)).toEqual([
        'mock-economy',
        'mock-advanced',
      ]);
      const res = await request(fresh.app.getHttpServer())
        .post('/api/ai/chat')
        .set('Authorization', tokenFor('gv'))
        .send({ message: 'x', model: 'mock-premium' });
      expect(res.status).toBe(403);
      const admin = await request(fresh.app.getHttpServer())
        .get('/api/ai/models')
        .set('Authorization', tokenFor('ai'))
        .expect(200);
      expect(admin.body.models.map((m: { id: string }) => m.id)).toContain('mock-premium');
    } finally {
      await fresh.app.close();
    }
  });

  it('reports provider errors in Vietnamese and stores them without a cost', async () => {
    const { status, events } = await chat('gv', { message: '[mock:fail=429] chào' });
    expect(status).toBe(200);
    expect(events.map((e) => e.type)).toEqual(['meta', 'error', 'done']);
    expect(events[1]).toMatchObject({
      code: 'rate_limited',
      message: expect.stringMatching(/quá tải/),
    });
    expect(events[2]).toMatchObject({ status: 'error', cost: null });
    // The reservation was given back: nothing billed.
    const ledger = await usage.listForUser('gv');
    expect(ledger.map((l) => [l.status, l.totalCost])).toEqual([['released', 0]]);
  });

  it('settles a cancelled answer: partial text kept, cost recorded', async () => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const conversationId = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/ai/chat',
          headers: { Authorization: tokenFor('gv'), 'Content-Type': 'application/json' },
        },
        (res) => {
          let cid = '';
          const parser = createSseParser((e) => {
            if (e.type === 'meta') cid = e.conversationId;
            if (e.type === 'delta') {
              req.destroy();
              resolve(cid);
            }
          });
          res.setEncoding('utf8');
          res.on('data', (c: string) => parser.push(c));
        },
      );
      req.on('error', (err) => (err.message.includes('socket hang up') ? undefined : reject(err)));
      req.end(JSON.stringify({ message: '[mock:slow=30] dài' }));
    });

    await vi.waitFor(
      async () => {
        const messages = await conversations.listMessages(conversationId);
        expect(messages[1]).toMatchObject({ status: 'cancelled', stopReason: 'cancelled' });
        expect(messages[1]?.content.startsWith('1… ')).toBe(true);
      },
      { timeout: 10_000, interval: 200 },
    );
    const ledger = await usage.listForUser('gv');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ outcome: 'cancelled' });
    expect(ledger[0]!.totalCost).toBeGreaterThan(0);
  });

  // Plan M5: a stream longer than 60 s must not be cut. Runs in CI (LONG_STREAM_TEST=1).
  it.runIf(process.env.LONG_STREAM_TEST === '1')(
    'streams for more than 60 seconds with heartbeats',
    async () => {
      const started = Date.now();
      const { raw, events } = await chat('gv', { message: '[mock:slow=62] dài' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(62_000);
      expect(events.at(-1)).toMatchObject({ type: 'done', status: 'complete' });
      expect(raw.match(/: ping/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    },
    90_000,
  );
});

describe('conversations API', () => {
  it('creates, renames, pins, lists and deletes', async () => {
    const gv = tokenFor('gv');
    const created = await http_()
      .post('/api/conversations')
      .set('Authorization', gv)
      .send({})
      .expect(201);
    expect(created.body).toMatchObject({ title: 'Hội thoại mới', pinned: false, messageCount: 0 });
    const id = created.body.id as string;
    const patched = await http_()
      .patch(`/api/conversations/${id}`)
      .set('Authorization', gv)
      .send({ title: 'Đề cương', pinned: true })
      .expect(200);
    expect(patched.body).toMatchObject({ title: 'Đề cương', pinned: true });
    const list = await http_().get('/api/conversations').set('Authorization', gv).expect(200);
    expect(list.body.conversations.map((c: { id: string }) => c.id)).toEqual([id]);
    expect(
      (await http_().get('/api/conversations').set('Authorization', tokenFor('ai'))).body
        .conversations,
    ).toEqual([]);
    expect(
      (await http_().delete(`/api/conversations/${id}`).set('Authorization', tokenFor('ai')))
        .status,
    ).toBe(404);
    await http_().delete(`/api/conversations/${id}`).set('Authorization', gv).expect(204);
    expect((await http_().get(`/api/conversations/${id}`).set('Authorization', gv)).status).toBe(
      404,
    );
    expect((await http_().get('/api/conversations/bad%20id').set('Authorization', gv)).status).toBe(
      404,
    );
  });
});

describe('without usable models', () => {
  it('AUTO answers 503 when only mock models exist and the mock is off', async () => {
    const prod = await startApp({ ENABLE_MOCK_PROVIDER: 'false' });
    try {
      const res = await request(prod.app.getHttpServer())
        .post('/api/ai/chat')
        .set('Authorization', tokenFor('gv'))
        .send({ message: 'Xin chào' });
      expect(res.status).toBe(503);
      expect(res.body.message).toMatch(/Chưa có model AI nào sẵn sàng/);
    } finally {
      await prod.app.close();
    }
  });
});
