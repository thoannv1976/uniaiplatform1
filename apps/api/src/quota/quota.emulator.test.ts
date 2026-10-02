import type { INestApplication } from '@nestjs/common';
import { getDb, QuotaService, RegistryStore } from '@uniai/firestore';
import { createSseParser, type ChatStreamEvent } from '@uniai/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { audit, givenUser, resetData, startApp, tokenFor } from '../test/harness.js';

let app: INestApplication;
const http = () => request(app.getHttpServer());
const quota = new QuotaService(getDb());

function events(text: string): ChatStreamEvent[] {
  const out: ChatStreamEvent[] = [];
  const p = createSseParser((e) => out.push(e));
  p.push(text);
  p.end();
  return out;
}
const chat = (who: string, body: Record<string, unknown>) =>
  http()
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

beforeAll(async () => {
  ({ app } = await startApp());
});
afterAll(async () => {
  await app?.close();
});
beforeEach(async () => {
  await resetData();
  await givenUser(app, 'sa', 'super_admin');
  await givenUser(app, 'gv', 'user', 'active', { departmentId: 'KTQT-KTVM' });
  await givenUser(app, 'ka', 'unit_admin', 'active', {
    departmentId: 'KTQT',
    scopeDepartmentId: 'KTQT',
  });
});

describe('quota on the chat path', () => {
  it('shows the quota, charges answers and refuses with 402 when it runs out', async () => {
    const before = await http()
      .get('/api/me/quota')
      .set('Authorization', tokenFor('gv'))
      .expect(200);
    expect(before.body).toMatchObject({
      limit: 2_000_000,
      used: 0,
      remaining: 2_000_000,
      tierId: 'standard',
    });

    const ok = await chat('gv', { message: 'Xin chào' });
    expect(ok.status).toBe(200);
    const done = events(ok.body as string).at(-1);
    const after = await http()
      .get('/api/me/quota')
      .set('Authorization', tokenFor('gv'))
      .expect(200);
    expect(after.body.used).toBe(done?.type === 'done' ? done.cost : -1);
    expect(after.body.reserved).toBe(0);

    await quota.adjust(
      {
        uid: 'gv',
        type: 'set',
        kind: 'monthly',
        amount: 0,
        reason: 'Thử hết hạn mức',
        approvedBy: 'Kiểm thử',
      },
      { uid: 'sa', role: 'super_admin', scopeDepartmentId: null },
    );
    const refused = await chat('gv', { message: 'Còn không?' });
    expect(refused.status).toBe(402);
    expect(JSON.parse(refused.body as string).message).toMatch(/hết định mức/);
  });

  it('answers 429 with Retry-After when a user sends too fast', async () => {
    for (let i = 0; i < 10; i++)
      expect((await chat('gv', { message: `câu ${i}` })).status).toBe(200);
    const res = await chat('gv', { message: 'quá nhanh' });
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('falls back to AUTO when the premium budget is used up', async () => {
    // mock-advanced is an "advanced" model: it counts against the premium budget.
    await quota.adjust(
      {
        uid: 'gv',
        type: 'set',
        kind: 'premium',
        amount: 0,
        reason: 'Hết hạn mức cao cấp',
        approvedBy: 'Kiểm thử',
      },
      { uid: 'sa', role: 'super_admin', scopeDepartmentId: null },
    );
    const res = await chat('gv', { message: 'Phân tích sâu', model: 'mock-advanced' });
    expect(res.status).toBe(200);
    const meta = events(res.body as string)[0];
    expect(meta).toMatchObject({
      type: 'meta',
      model: { id: 'mock-economy' },
      routeReason: expect.stringMatching(/Hết hạn mức model Nâng cao\/Cao cấp/),
    });
  });

  it('refuses a premium-only choice when no cheaper model exists', async () => {
    const registry = new RegistryStore(getDb());
    await registry.updateModel('mock-economy', { status: 'disabled' }, 'test');
    const fresh = await startApp();
    try {
      await quota.adjust(
        {
          uid: 'gv',
          type: 'set',
          kind: 'premium',
          amount: 0,
          reason: 'Hết hạn mức cao cấp',
          approvedBy: 'Kiểm thử',
        },
        { uid: 'sa', role: 'super_admin', scopeDepartmentId: null },
      );
      const res = await request(fresh.app.getHttpServer())
        .post('/api/ai/chat')
        .set('Authorization', tokenFor('gv'))
        .send({ message: 'x', model: 'mock-advanced' });
      expect(res.status).toBe(402);
      expect(res.body.message).toMatch(/model cao cấp/);
    } finally {
      await fresh.app.close();
    }
  });
});

describe('admin quota API', () => {
  it('unit admins adjust only their people, with reason; changes are audited', async () => {
    await givenUser(app, 'other', 'user', 'active', { departmentId: 'QTKD' });
    const ka = tokenFor('ka');
    const list = await http().get('/api/admin/quotas').set('Authorization', ka).expect(200);
    expect(list.body.quotas.map((q: { uid: string }) => q.uid).sort()).toEqual(['gv', 'ka']);

    const missingReason = await http()
      .post('/api/admin/quota-adjustments')
      .set('Authorization', ka)
      .send({
        uid: 'gv',
        type: 'increase',
        amount: 500_000,
        reason: '',
        approvedBy: 'Trưởng khoa',
      });
    expect(missingReason.status).toBe(400);

    await http()
      .post('/api/admin/quota-adjustments')
      .set('Authorization', ka)
      .send({
        uid: 'gv',
        type: 'increase',
        amount: 500_000,
        reason: 'Đề tài NCKH',
        approvedBy: 'Trưởng khoa',
      })
      .expect(201);
    const outside = await http()
      .post('/api/admin/quota-adjustments')
      .set('Authorization', ka)
      .send({
        uid: 'other',
        type: 'increase',
        amount: 1,
        reason: 'Ngoài đơn vị',
        approvedBy: 'Trưởng khoa',
      });
    expect(outside.status).toBe(403);

    const log = (await audit().list()).find((l) => l.event === 'QUOTA_CHANGE');
    expect(log).toMatchObject({
      actor: 'ka',
      target: 'user:gv',
      metadata: { reason: 'Đề tài NCKH', delta: 500_000 },
    });
    const adjustments = await http()
      .get('/api/admin/quota-adjustments')
      .set('Authorization', ka)
      .expect(200);
    expect(adjustments.body.adjustments).toHaveLength(1);
  });

  it('budgets: set by super admin, checked against allocations, audited', async () => {
    const sa = tokenFor('sa');
    const low = await http()
      .put('/api/admin/budgets/KTQT')
      .set('Authorization', sa)
      .send({ budget: 1_000_000, reason: 'Phân bổ tháng' });
    expect(low.status).toBe(400); // gv + ka already hold $4
    const set = await http()
      .put('/api/admin/budgets/KTQT')
      .set('Authorization', sa)
      .send({ budget: 10_000_000, reason: 'Phân bổ tháng' })
      .expect(200);
    expect(set.body.budgets).toEqual([
      expect.objectContaining({ departmentId: 'KTQT', budget: 10_000_000, allocated: 4_000_000 }),
    ]);
    expect(
      (
        await http()
          .put('/api/admin/budgets/KHONGCO')
          .set('Authorization', sa)
          .send({ budget: 1, reason: 'Thử thôi' })
      ).status,
    ).toBe(404);
    expect((await audit().list()).some((l) => l.event === 'BUDGET_CHANGE')).toBe(true);
    // Unit admins may split their unit's budget among sub-units only.
    const ka = tokenFor('ka');
    expect(
      (
        await http()
          .put('/api/admin/budgets/KTQT')
          .set('Authorization', ka)
          .send({ budget: 9_000_000, reason: 'Tự tăng' })
      ).status,
    ).toBe(403);
    await http()
      .put('/api/admin/budgets/KTQT-KTVM')
      .set('Authorization', ka)
      .send({ budget: 3_000_000, reason: 'Chia cho bộ môn' })
      .expect(200);
    // M16: never more than the parent unit's budget.
    const over = await http()
      .put('/api/admin/budgets/KTQT-KTVM')
      .set('Authorization', ka)
      .send({ budget: 11_000_000, reason: 'Chia quá tay' });
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/Vượt ngân sách của đơn vị cha KTQT/);
  });

  it('tiers can be changed by the super admin only', async () => {
    const tiers = await http()
      .get('/api/admin/quota-tiers')
      .set('Authorization', tokenFor('ka'))
      .expect(200);
    expect(tiers.body.tiers.map((t: { id: string }) => t.id)).toEqual([
      'standard',
      'power',
      'research',
    ]);
    await http()
      .patch('/api/admin/quota-tiers/standard')
      .set('Authorization', tokenFor('sa'))
      .send({ monthlyBudget: 1_000_000 })
      .expect(200);
    expect(
      (
        await http()
          .patch('/api/admin/quota-tiers/vip')
          .set('Authorization', tokenFor('sa'))
          .send({ monthlyBudget: 1 })
      ).status,
    ).toBe(404);
  });
});
