import type { INestApplication } from '@nestjs/common';
import { AlertService, getDb, runUsageJob } from '@uniai/firestore';
import {
  createSseParser,
  dashboardSchema,
  myUsageSchema,
  notificationListResponseSchema,
  quotaPeriodOf,
  type ChatStreamEvent,
} from '@uniai/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { audit, givenUser, resetData, startApp, tokenFor } from '../test/harness.js';

let app: INestApplication;
const http = () => request(app.getHttpServer());
const period = quotaPeriodOf(new Date());

function doneCost(text: string): number {
  const out: ChatStreamEvent[] = [];
  const p = createSseParser((e) => out.push(e));
  p.push(text);
  p.end();
  const done = out.at(-1);
  return done?.type === 'done' ? (done.cost ?? -1) : -1;
}
const chat = async (who: string, message: string) => {
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
  return doneCost(res.body as string);
};
/** The aggregator leaves the last 30 s for the next run; pretend a minute has passed. */
const aggregate = () => runUsageJob(getDb(), new Date(Date.now() + 60_000));

beforeAll(async () => {
  ({ app } = await startApp());
});
afterAll(async () => {
  await app?.close();
});
beforeEach(async () => {
  await resetData();
  await givenUser(app, 'sa', 'super_admin');
  await givenUser(app, 'au', 'auditor');
  await givenUser(app, 'gv-kt', 'user', 'active', { departmentId: 'KTQT-KTVM' });
  await givenUser(app, 'gv-qt', 'user', 'active', { departmentId: 'QTKD' });
  await givenUser(app, 'ka', 'unit_admin', 'active', {
    departmentId: 'KTQT',
    scopeDepartmentId: 'KTQT',
  });
});

describe('usage dashboards', () => {
  it('matches the ledger for the university and a unit, and scopes unit admins', async () => {
    const a = await chat('gv-kt', 'Câu hỏi một');
    const b = await chat('gv-kt', 'Câu hỏi hai');
    const c = await chat('gv-qt', 'Câu hỏi ba');
    expect(Math.min(a, b, c)).toBeGreaterThan(0);
    const job = await aggregate();
    expect(job).toMatchObject({ period, added: 3 });

    const uni = dashboardSchema.parse(
      (await http().get('/api/admin/dashboard').set('Authorization', tokenFor('au')).expect(200))
        .body,
    );
    expect(uni).toMatchObject({ departmentId: null, totalCost: a + b + c, requests: 3 });
    expect(uni.activeUsers).toBe(2);
    expect(uni.byModel.reduce((s, m) => s + m.cost, 0)).toBe(a + b + c);
    expect(uni.byDay.reduce((s, d) => s + d.cost, 0)).toBe(a + b + c);
    // Ranking of FTU's direct sub-units.
    const ranking = Object.fromEntries(uni.byDepartment.map((d) => [d.key, d.cost]));
    expect(ranking).toMatchObject({ KTQT: a + b, QTKD: c });

    const unit = dashboardSchema.parse(
      (
        await http()
          .get('/api/admin/dashboard?departmentId=KTQT')
          .set('Authorization', tokenFor('sa'))
          .expect(200)
      ).body,
    );
    expect(unit).toMatchObject({ departmentId: 'KTQT', totalCost: a + b, requests: 2 });
    expect(unit.activeUsers).toBe(1);
    expect(unit.byDepartment.map((d) => d.key)).toEqual(['KTQT-KTVM']);

    // A unit admin asking for another unit still gets their own.
    const own = await http()
      .get('/api/admin/dashboard?departmentId=QTKD')
      .set('Authorization', tokenFor('ka'))
      .expect(200);
    expect(own.body).toMatchObject({ departmentId: 'KTQT', totalCost: a + b });

    // Running the job again adds nothing (exactly-once).
    expect((await aggregate()).added).toBe(0);
  });

  it('exports CSV per department, model and user within the scope', async () => {
    await chat('gv-kt', 'Một');
    await chat('gv-qt', 'Hai');
    await aggregate();
    const csv = (kind: string, who: string) =>
      http()
        .get(`/api/admin/usage/export.csv?kind=${kind}`)
        .set('Authorization', tokenFor(who))
        .expect(200);
    const depts = await csv('departments', 'sa');
    expect(depts.headers['content-type']).toContain('text/csv');
    expect(depts.text.split('\n')[0]).toContain('chi_phi_vnd');
    expect(depts.text).toContain('KTQT');
    expect(depts.text).toContain('QTKD');
    expect((await csv('models', 'au')).text).toContain('mock-');
    const users = await csv('users', 'ka');
    expect(users.text).toContain('gv-kt@ftu.edu.vn');
    expect(users.text).not.toContain('gv-qt@ftu.edu.vn');
    await http()
      .get('/api/admin/usage/export.csv?kind=secrets')
      .set('Authorization', tokenFor('sa'))
      .expect(404);
  });

  it('sets the exchange rate (super admin, audited) and validates it', async () => {
    const get = () =>
      http().get('/api/admin/settings/exchange-rate').set('Authorization', tokenFor('au'));
    expect((await get().expect(200)).body).toEqual({ vndPerUsd: 26_000 });
    await http()
      .put('/api/admin/settings/exchange-rate')
      .set('Authorization', tokenFor('sa'))
      .send({ vndPerUsd: 12.5 })
      .expect(400);
    await http()
      .put('/api/admin/settings/exchange-rate')
      .set('Authorization', tokenFor('sa'))
      .send({ vndPerUsd: 25_400 })
      .expect(200);
    expect((await get().expect(200)).body).toEqual({ vndPerUsd: 25_400 });
    const change = (await audit().list()).find((l) => l.target === 'settings:exchangeRate');
    expect(change?.metadata).toMatchObject({ before: 26_000, after: 25_400 });
  });
});

describe('my usage and notifications', () => {
  it('shows personal usage straight from the ledger', async () => {
    const a = await chat('gv-kt', 'Xin chào');
    const res = await http().get('/api/me/usage').set('Authorization', tokenFor('gv-kt'));
    const mine = myUsageSchema.parse(res.body);
    expect(mine).toMatchObject({ period, totalCost: a, requests: 1, vndPerUsd: 26_000 });
    expect(mine.quota.used).toBe(a);
    expect(mine.byDay).toHaveLength(1);
    const other = myUsageSchema.parse(
      (await http().get('/api/me/usage').set('Authorization', tokenFor('gv-qt'))).body,
    );
    expect(other.totalCost).toBe(0);
    await http()
      .get('/api/me/usage?period=2026-10')
      .set('Authorization', tokenFor('gv-kt'))
      .expect(400);
  });

  it('lists only my notifications and marks them read', async () => {
    const alerts = new AlertService(getDb());
    await alerts.checkUser('gv-kt', period, 1_500_000, 1_700_000, 2_000_000);
    await alerts.checkUser('gv-kt', period, 1_700_000, 1_800_000, 2_000_000); // once only
    const list = async (who: string) =>
      notificationListResponseSchema.parse(
        (await http().get('/api/me/notifications').set('Authorization', tokenFor(who))).body,
      );
    const mine = await list('gv-kt');
    expect(mine.unread).toBe(1);
    expect(mine.notifications[0]?.type).toBe('quota_80');
    expect((await list('gv-qt')).notifications).toEqual([]);

    await http()
      .post('/api/me/notifications/read')
      .set('Authorization', tokenFor('gv-qt'))
      .send({})
      .expect(204);
    expect((await list('gv-kt')).unread).toBe(1);
    await http()
      .post('/api/me/notifications/read')
      .set('Authorization', tokenFor('gv-kt'))
      .send({ ids: [mine.notifications[0]!.id] })
      .expect(204);
    expect((await list('gv-kt')).unread).toBe(0);
  });

  it('notifies the user when an answer crosses 80 % of the quota', async () => {
    // Standard quota is $2; leave just over 20 % so the next answer crosses the line.
    await getDb()
      .collection('quotaPeriods')
      .doc(`gv-kt_${period}`)
      .set({ tierId: 'standard', limit: 2_000_000, premiumLimit: 0, used: 1_599_999 });
    await chat('gv-kt', 'Thêm một câu');
    let unread = 0;
    for (let i = 0; i < 20 && unread === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      unread = (await http().get('/api/me/notifications').set('Authorization', tokenFor('gv-kt')))
        .body.unread;
    }
    expect(unread).toBe(1);
  });
});
