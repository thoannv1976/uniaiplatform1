import type { INestApplication } from '@nestjs/common';
import { getDb } from '@uniai/firestore';
import {
  createSseParser,
  DEFAULT_ROUTER_CONFIG,
  quotaPeriodOf,
  routerViewSchema,
  type ChatStreamEvent,
} from '@uniai/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { audit, givenUser, resetData, startApp, tokenFor } from '../test/harness.js';
import { RouterService } from './router.service.js';

let app: INestApplication;
const http = () => request(app.getHttpServer());

async function chatMeta(who: string, message: string) {
  const res = await http()
    .post('/api/ai/chat')
    .set('Authorization', tokenFor(who))
    .send({ message })
    .buffer(true)
    .parse((r, cb) => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', (c: string) => (data += c));
      r.on('end', () => cb(null, data));
    });
  expect(res.status).toBe(200);
  const events: ChatStreamEvent[] = [];
  const p = createSseParser((e) => events.push(e));
  p.push(res.body as string);
  p.end();
  const meta = events[0];
  if (meta?.type !== 'meta') throw new Error('no meta');
  return meta;
}

beforeAll(async () => {
  ({ app } = await startApp());
});
afterAll(async () => {
  await app?.close();
});
beforeEach(async () => {
  await resetData();
  app.get(RouterService).invalidate();
  await givenUser(app, 'gv', 'user', 'active', { departmentId: 'QTKD' });
  await givenUser(app, 'ai', 'ai_admin');
  await givenUser(app, 'au', 'auditor');
});

describe('Smart Router in chat', () => {
  it('routes by rule, explains why, and moves to the nearest tier with a model', async () => {
    const research = await chatMeta('gv', 'Phân tích chuyên sâu tác động của CPTPP');
    expect(research.model.id).toBe('mock-advanced');
    expect(research.routeReason).toContain('luật "Nghiên cứu, phân tích chuyên sâu"');

    const simple = await chatMeta('gv', 'Thủ đô của Úc là gì?');
    expect(simple.model.id).toBe('mock-economy');
    expect(simple.routeReason).toContain('câu hỏi thông thường');

    // No Standard mock model: the nearest tier (cheaper first) answers.
    const code = await chatMeta('gv', 'Viết hàm Python tính điểm trung bình');
    expect(code.model.id).toBe('mock-economy');
    expect(code.routeReason).toContain('nhóm Tiêu chuẩn không có model sẵn sàng');

    const ledger = await getDb().collection('usageTransactions').where('uid', '==', 'gv').get();
    expect(ledger.docs.map((d) => d.get('routeReason') as string).join('\n')).toContain(
      'luật "Nghiên cứu',
    );
  });

  it('drops to a cheaper tier when the premium budget is used up', async () => {
    await getDb()
      .collection('quotaPeriods')
      .doc(`gv_${quotaPeriodOf(new Date())}`)
      .set({ tierId: 'standard', limit: 2_000_000, premiumLimit: 0, used: 0 });
    const meta = await chatMeta('gv', 'Phân tích chuyên sâu tác động của CPTPP');
    expect(meta.model.id).toBe('mock-economy');
    expect(meta.routeReason).toContain('Hết hạn mức model Nâng cao/Cao cấp');
  });
});

describe('/api/admin/router', () => {
  it('returns the defaults with this month’s shares, saves changes and audits them', async () => {
    const view = routerViewSchema.parse(
      (await http().get('/api/admin/router').set('Authorization', tokenFor('au')).expect(200)).body,
    );
    expect(view.config).toEqual(DEFAULT_ROUTER_CONFIG);
    expect(view.actual).toEqual({ economy: 0, standard: 0, advanced: 0, premium: 0 });

    const config = {
      ...DEFAULT_ROUTER_CONFIG,
      defaultTier: 'advanced',
      rules: DEFAULT_ROUTER_CONFIG.rules.filter((r) => r.id !== 'nghien-cuu-chuyen-sau'),
    };
    await http()
      .put('/api/admin/router')
      .set('Authorization', tokenFor('ai'))
      .send({ ...config, targets: { economy: 10, standard: 10, advanced: 10 } })
      .expect(400);
    const saved = await http()
      .put('/api/admin/router')
      .set('Authorization', tokenFor('ai'))
      .send(config)
      .expect(200);
    expect(saved.body.config.defaultTier).toBe('advanced');
    expect(saved.body.updatedBy).toBe('ai');
    // Takes effect at once on this instance.
    expect((await chatMeta('gv', 'Thủ đô của Úc là gì?')).model.id).toBe('mock-advanced');
    const change = (await audit().list()).find((l) => l.target === 'settings:router');
    expect(change).toMatchObject({ event: 'ADMIN_CHANGE', actor: 'ai' });
  });

  it('tests a question without calling AI', async () => {
    const res = await http()
      .post('/api/admin/router/test')
      .set('Authorization', tokenFor('ai'))
      .send({ text: 'Soạn đề thi cuối kỳ', documentCount: 0 })
      .expect(200);
    expect(res.body).toMatchObject({
      tier: 'standard',
      ruleId: 'soan-thao',
      modelId: 'mock-economy',
    });
    const image = await http()
      .post('/api/admin/router/test')
      .set('Authorization', tokenFor('ai'))
      .send({ text: 'Ảnh gì?', imageCount: 1 })
      .expect(200);
    expect(image.body).toMatchObject({ ruleId: 'anh', modelId: 'mock-advanced' });
  });
});
