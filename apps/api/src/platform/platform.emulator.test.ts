import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import type { NormalizedChatRequest } from '@uniai/ai-providers';
import { getDb, QuotaService, runUsageJob } from '@uniai/firestore';
import {
  appClientKeyResponseSchema,
  platformChatResponseSchema,
  platformStreamEventSchema,
  quotaPeriodOf,
  usdToMicro,
  type PlatformStreamEvent,
} from '@uniai/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { audit, givenUser, resetData, startApp, tokenFor } from '../test/harness.js';

let app: INestApplication;
let requests: NormalizedChatRequest[];
const http = () => request(app.getHttpServer());
const period = quotaPeriodOf(new Date());
const bearer = (key: string) => `Bearer ${key}`;

async function createApp(over: Record<string, unknown> = {}) {
  const res = await http()
    .post('/api/admin/app-clients')
    .set('Authorization', tokenFor('sa'))
    .send({
      name: 'LMS',
      ownerDepartmentId: 'KTQT',
      scopes: ['chat', 'usage'],
      monthlyBudget: usdToMicro(1),
      ...over,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return appClientKeyResponseSchema.parse(res.body);
}

const chat = (key: string, body: Record<string, unknown>) =>
  http().post('/api/platform/v1/chat').set('Authorization', bearer(key)).send(body);

function events(raw: string): PlatformStreamEvent[] {
  return raw
    .split('\n\n')
    .map((block) => block.split('\n').find((l) => l.startsWith('data: ')))
    .filter((l): l is string => !!l)
    .map((l) => platformStreamEventSchema.parse(JSON.parse(l.slice(6))));
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
  await givenUser(app, 'sa', 'super_admin');
  await givenUser(app, 'ai', 'ai_admin');
  await givenUser(app, 'au', 'auditor');
  await givenUser(app, 'gv', 'user', 'active', { departmentId: 'KTQT' });
});

describe('Platform API – sample application', () => {
  it('answers, bills the app budget and its unit, and keeps the key secret', async () => {
    const { client, key } = await createApp();
    const res = await chat(key, {
      messages: [
        { role: 'system', content: 'Bạn là trợ lý của hệ thống LMS.' },
        { role: 'user', content: 'Chào' },
        { role: 'assistant', content: 'Xin chào!' },
        { role: 'user', content: 'Tóm tắt bài 1' },
      ],
      reference: 'lms:course-42',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = platformChatResponseSchema.parse(res.body);
    expect(body.output).toBe('[mock:mock-economy] Tóm tắt bài 1');
    expect(body.cost).toBeGreaterThan(0);
    expect(requests[0]?.messages[0]).toEqual({
      role: 'system',
      content: 'Bạn là trợ lý của hệ thống LMS.',
    });
    expect(requests[0]?.messages).toHaveLength(4);

    const ledger = (await getDb().collection('usageTransactions').doc(body.id).get()).data()!;
    expect(ledger).toMatchObject({
      status: 'committed',
      uid: `app:${client.id}`,
      appClientId: client.id,
      reference: 'lms:course-42',
      departmentPath: ['FTU', 'KTQT'],
      totalCost: body.cost,
    });
    const usage = await http().get('/api/platform/v1/usage').set('Authorization', bearer(key));
    expect(usage.body).toMatchObject({
      appId: client.id,
      period,
      monthlyBudget: usdToMicro(1),
      used: body.cost,
      reserved: 0,
    });

    // The unit's dashboard includes the app's spend (aggregation job).
    await runUsageJob(getDb(), new Date(Date.now() + 60_000));
    const dash = await http()
      .get('/api/admin/dashboard?departmentId=KTQT')
      .set('Authorization', tokenFor('sa'));
    expect(dash.body.totalCost).toBe(body.cost);
    expect(dash.body.activeUsers).toBe(0);

    const logs = await audit().list();
    const created = logs.find((l) => l.metadata?.action === 'app_client_create');
    expect(JSON.stringify(created)).not.toContain(key);
    expect(logs.find((l) => l.event === 'AI_REQUEST')).toMatchObject({
      actor: `app:${client.id}`,
      metadata: { reference: 'lms:course-42', cost: body.cost },
    });
  });

  it('streams Server-Sent Events', async () => {
    const { key } = await createApp();
    const res = await chat(key, { messages: [{ role: 'user', content: 'Xin chào' }], stream: true })
      .buffer(true)
      .parse((r, cb) => {
        let data = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => (data += c));
        r.on('end', () => cb(null, data));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const list = events(res.body as string);
    expect(list[0]).toMatchObject({ type: 'meta', model: { id: 'mock-economy' } });
    expect(list.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('')).toBe(
      '[mock:mock-economy] Xin chào',
    );
    const done = list.at(-1);
    expect(done).toMatchObject({ type: 'done', id: list[0]?.type === 'meta' ? list[0].id : '' });
    expect(done?.type === 'done' && done.cost).toBeGreaterThan(0);
  });

  it('rejects staff tokens, bad or rotated keys, missing scopes and disabled apps', async () => {
    const { client, key } = await createApp();
    const msg = { messages: [{ role: 'user', content: 'x' }] };
    expect((await http().post('/api/platform/v1/chat').send(msg)).status).toBe(401);
    expect(
      (await http().post('/api/platform/v1/chat').set('Authorization', tokenFor('sa')).send(msg))
        .status,
    ).toBe(401);
    expect((await chat(`${key.slice(0, -2)}xx`, msg)).status).toBe(401);
    expect(
      (await http().get('/api/platform/v1/models').set('Authorization', bearer(key))).status,
    ).toBe(403);

    const rotated = await http()
      .post(`/api/admin/app-clients/${client.id}/rotate`)
      .set('Authorization', tokenFor('ai'))
      .expect(201);
    const newKey = appClientKeyResponseSchema.parse(rotated.body).key;
    expect((await chat(key, msg)).status).toBe(401);
    expect((await chat(newKey, msg)).status).toBe(200);

    await http()
      .patch(`/api/admin/app-clients/${client.id}`)
      .set('Authorization', tokenFor('sa'))
      .send({ status: 'disabled' })
      .expect(200);
    const disabled = await chat(newKey, msg);
    expect(disabled.status).toBe(403);
    expect(disabled.body.message).toContain('tạm dừng');
    const denied = (await audit().list()).filter((l) => l.event === 'AUTH_DENIED');
    expect(JSON.stringify(denied)).not.toContain(key.slice(-10));
  });

  it('enforces the budget, the model tier and DLP', async () => {
    const { client, key } = await createApp({
      monthlyBudget: 0,
      scopes: ['chat', 'models'],
    });
    const msg = { messages: [{ role: 'user', content: 'Xin chào' }] };
    const broke = await chat(key, msg);
    expect(broke.status).toBe(402);
    expect(broke.body.message).toContain('Ứng dụng đã dùng hết ngân sách AI tháng này');

    await http()
      .patch(`/api/admin/app-clients/${client.id}`)
      .set('Authorization', tokenFor('sa'))
      .send({ monthlyBudget: usdToMicro(1) })
      .expect(200);
    const advanced = await chat(key, { ...msg, model: 'mock-advanced' });
    expect(advanced.status).toBe(403);
    const models = await http().get('/api/platform/v1/models').set('Authorization', bearer(key));
    expect(models.body.models.map((m: { id: string }) => m.id)).not.toContain('mock-advanced');
    // AUTO stays below the Advanced tier for this app.
    const research = await chat(key, {
      messages: [{ role: 'user', content: 'Phân tích chuyên sâu tác động của CPTPP' }],
    });
    expect(research.body.model.id).toBe('mock-economy');

    const blocked = await chat(key, {
      messages: [{ role: 'user', content: 'Đăng nhập giúp, mật khẩu: Abc@12345' }],
    });
    expect(blocked.status).toBe(422);
    const masked = await chat(key, {
      messages: [{ role: 'user', content: 'CCCD 001203004567, nhắc lại' }],
    });
    expect(masked.status).toBe(200);
    expect(JSON.stringify(requests.at(-1))).not.toContain('001203004567');
    expect(masked.body.output).toContain('001203004567');
    const dlp = (await audit().list()).filter((l) => l.event === 'DLP_ACTION');
    expect(dlp.map((l) => l.actor)).toContain(`app:${client.id}`);
    expect(JSON.stringify(dlp)).not.toContain('Abc@12345');
  });
});

describe('examples/platform-client', () => {
  it('runs the sample app against the API, plain and streaming', async () => {
    const { key } = await createApp();
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const run = (...args: string[]) =>
      promisify(execFile)(
        process.execPath,
        [
          new URL('../../../../examples/platform-client/chat.mjs', import.meta.url).pathname,
          ...args,
        ],
        { env: { ...process.env, UNIAI_API_URL: `http://127.0.0.1:${port}`, UNIAI_APP_KEY: key } },
      );
    const plain = await run('Xin chào');
    expect(plain.stdout).toContain('[mock:mock-economy] Xin chào');
    expect(plain.stdout).toMatch(/đã dùng \$0\.\d{4} \/ \$1\.0000/);
    const streamed = await run('Viết một câu', '--stream');
    expect(streamed.stdout).toContain('[mock:mock-economy] Viết một câu');
    expect(streamed.stdout).toContain('mã giao dịch');
  });
});

describe('App client administration', () => {
  it('keeps app budgets inside the unit budget and lists spend', async () => {
    const quota = new QuotaService(getDb());
    const sa = { uid: 'sa', role: 'super_admin' as const, scopeDepartmentId: null };
    await quota.setBudget(
      { id: 'FTU', parentId: null, path: ['FTU'] },
      period,
      usdToMicro(100),
      sa,
    );
    await quota.setBudget(
      { id: 'KTQT', parentId: 'FTU', path: ['FTU', 'KTQT'] },
      period,
      usdToMicro(5),
      sa,
    );
    const over = await http()
      .post('/api/admin/app-clients')
      .set('Authorization', tokenFor('sa'))
      .send({
        name: 'Quá ngân sách',
        ownerDepartmentId: 'KTQT',
        scopes: ['chat'],
        monthlyBudget: usdToMicro(10),
      });
    expect(over.status).toBe(400);
    expect(over.body.message).toContain('Vượt ngân sách đơn vị KTQT');
    expect(
      (
        await http()
          .post('/api/admin/app-clients')
          .set('Authorization', tokenFor('sa'))
          .send({ name: 'X', ownerDepartmentId: 'KHONGCO', scopes: ['chat'], monthlyBudget: 1 })
      ).status,
    ).toBe(404);

    const { client, key } = await createApp({ monthlyBudget: usdToMicro(1) });
    await chat(key, { messages: [{ role: 'user', content: 'Xin chào' }] }).expect(200);
    const list = await http().get('/api/admin/app-clients').set('Authorization', tokenFor('au'));
    expect(list.status).toBe(200);
    expect(list.body.clients).toEqual([
      expect.objectContaining({ id: client.id, keyLast4: key.slice(-4), period }),
    ]);
    expect(list.body.clients[0].used).toBeGreaterThan(0);
    expect(JSON.stringify(list.body)).not.toContain(key);
    expect(JSON.stringify(list.body)).not.toContain('keyHash');
    const doc = await http()
      .get('/api/admin/platform/openapi.json')
      .set('Authorization', tokenFor('au'));
    expect(doc.body.paths['/api/platform/v1/chat']).toBeDefined();
  });
});
