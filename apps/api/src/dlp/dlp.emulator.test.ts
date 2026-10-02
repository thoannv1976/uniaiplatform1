import type { INestApplication } from '@nestjs/common';
import type { NormalizedChatRequest } from '@uniai/ai-providers';
import { getDb } from '@uniai/firestore';
import {
  createSseParser,
  DEFAULT_DLP_POLICY,
  dlpPolicyViewSchema,
  type ChatStreamEvent,
  type DlpPolicy,
} from '@uniai/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { audit, givenUser, resetData, startApp, tokenFor } from '../test/harness.js';
import { DlpService } from './dlp.service.js';

let app: INestApplication;
let requests: NormalizedChatRequest[];
const http = () => request(app.getHttpServer());

async function chat(who: string, body: Record<string, unknown>) {
  const res = await http()
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
  const events: ChatStreamEvent[] = [];
  if (res.status === 200) {
    const p = createSseParser((e) => events.push(e));
    p.push(res.body as string);
    p.end();
  }
  const text = events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');
  const body_ = res.status === 200 ? null : (JSON.parse(res.body as string) as { message: string });
  return { status: res.status, events, text, error: body_?.message ?? null };
}

const lastUserContent = (r: NormalizedChatRequest | undefined) =>
  r?.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
const dlpAudits = async () => (await audit().list()).filter((e) => e.event === 'DLP_ACTION');

async function setPolicy(policy: DlpPolicy) {
  const res = await http()
    .put('/api/admin/dlp-rules')
    .set('Authorization', tokenFor('sa'))
    .send(policy);
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  ({ app, requests } = await startApp());
});
afterAll(async () => {
  await app?.close();
});
beforeEach(async () => {
  await resetData();
  requests.length = 0;
  app.get(DlpService).invalidate();
  await givenUser(app, 'gv', 'user', 'active', { departmentId: 'QTKD' });
  await givenUser(app, 'sa', 'super_admin');
  await givenUser(app, 'au', 'auditor');
});

describe('DLP in chat', () => {
  it('masks a citizen ID before sending and restores it in the answer', async () => {
    const r = await chat('gv', { message: 'Số CCCD của tôi là 001203004567, hãy nhắc lại' });
    expect(r.status).toBe(200);
    expect(lastUserContent(requests[0])).toBe('Số CCCD của tôi là [CCCD_1], hãy nhắc lại');
    expect(JSON.stringify(requests)).not.toContain('001203004567');
    expect(r.events.find((e) => e.type === 'dlp')).toEqual({
      type: 'dlp',
      masked: [{ detector: 'cccd', count: 1 }],
      acknowledged: [],
    });
    // The mock echoes the prompt: the user sees their own number again, not the placeholder.
    expect(r.text).toContain('001203004567');
    expect(r.text).not.toContain('[CCCD_1]');
    const meta = r.events[0];
    if (meta?.type !== 'meta') throw new Error('no meta');
    const stored = await getDb()
      .collection('conversations')
      .doc(meta.conversationId)
      .collection('messages')
      .doc(meta.messageId)
      .get();
    expect(stored.get('content')).toContain('001203004567');

    const entries = await dlpAudits();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: 'gv',
      metadata: { action: 'mask', outcome: 'sent', counts: { cccd: 1 } },
    });
    expect(JSON.stringify(entries)).not.toContain('001203004567');

    // Later turns: the earlier message is sent again, still masked.
    const next = await chat('gv', { conversationId: meta.conversationId, message: 'Cảm ơn' });
    expect(next.status).toBe(200);
    expect(JSON.stringify(requests[1])).not.toContain('001203004567');
    expect(JSON.stringify(requests[1])).toContain('[CCCD_1]');
  });

  it('blocks passwords and secrets (422) before anything is stored or sent', async () => {
    const r = await chat('gv', { message: 'Đăng nhập giúp tôi, mật khẩu: Abc@12345' });
    expect(r.status).toBe(422);
    expect(r.error).toContain('mật khẩu');
    expect(r.error).not.toContain('Abc@12345');
    expect(requests).toHaveLength(0);
    expect((await getDb().collection('conversations').get()).size).toBe(0);
    expect((await getDb().collection('usageTransactions').get()).size).toBe(0);
    const [entry] = await dlpAudits();
    expect(entry).toMatchObject({ metadata: { action: 'block', counts: { password: 1 } } });
    expect(JSON.stringify(entry)).not.toContain('Abc@12345');
  });

  it('asks for confirmation (428) on student data, then sends once confirmed', async () => {
    const message = 'MSV 11201234, điểm giữa kỳ 8.5 – viết nhận xét';
    const first = await chat('gv', { message });
    expect(first.status).toBe(428);
    expect(first.error).toContain('dữ liệu sinh viên');
    expect(requests).toHaveLength(0);

    const confirmed = await chat('gv', { message, dlpAcknowledged: true });
    expect(confirmed.status).toBe(200);
    expect(lastUserContent(requests[0])).toBe(message);
    expect(confirmed.events.find((e) => e.type === 'dlp')).toEqual({
      type: 'dlp',
      masked: [],
      acknowledged: ['student_data'],
    });
    const outcomes = (await dlpAudits()).map((e) => e.metadata?.outcome).sort();
    expect(outcomes).toEqual(['confirm_required', 'sent']);
  });

  it('lets an ordinary question through untouched', async () => {
    const r = await chat('gv', { message: 'Năm 2026 trường tuyển 4000 sinh viên, gọi 0912345678' });
    expect(r.status).toBe(200);
    expect(r.events.some((e) => e.type === 'dlp')).toBe(false);
    expect(await dlpAudits()).toHaveLength(0);
  });
});

describe('DLP rules administration', () => {
  it('auditors read, Super Admin changes the policy and it applies at once', async () => {
    const view = await http().get('/api/admin/dlp-rules').set('Authorization', tokenFor('au'));
    expect(view.status).toBe(200);
    expect(dlpPolicyViewSchema.parse(view.body).policy).toEqual(DEFAULT_DLP_POLICY);
    expect(
      (
        await http()
          .put('/api/admin/dlp-rules')
          .set('Authorization', tokenFor('au'))
          .send(DEFAULT_DLP_POLICY)
      ).status,
    ).toBe(403);

    // Citizen IDs blocked for everyone; student data allowed for the training office (QTKD
    // here) only.
    await setPolicy({
      defaults: { ...DEFAULT_DLP_POLICY.defaults, cccd: 'block' },
      overrides: [
        {
          detector: 'student_data',
          action: 'allow',
          departmentIds: ['QTKD'],
          roles: [],
          note: 'Phòng đào tạo',
        },
      ],
    });
    expect((await chat('gv', { message: 'CCCD 001203004567' })).status).toBe(422);
    expect((await chat('gv', { message: 'MSV 11201234, điểm giữa kỳ 8.5' })).status).toBe(200);
    await givenUser(app, 'gv2', 'user', 'active', { departmentId: 'QLDT' });
    expect((await chat('gv2', { message: 'MSV 11201234, điểm giữa kỳ 8.5' })).status).toBe(428);

    const change = (await audit().list()).find(
      (e) => e.event === 'ADMIN_CHANGE' && e.target === 'settings:dlp',
    );
    expect(change?.actor).toBe('sa');
  });

  it('rejects an invalid policy and previews a sample text', async () => {
    const bad = await http()
      .put('/api/admin/dlp-rules')
      .set('Authorization', tokenFor('sa'))
      .send({ defaults: { cccd: 'drop' }, overrides: [] });
    expect(bad.status).toBe(400);

    const res = await http()
      .post('/api/admin/dlp-rules/test')
      .set('Authorization', tokenFor('sa'))
      .send({ text: 'STK 0011004123456 Vietcombank, mật khẩu: Abc@12345' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      action: 'block',
      findings: [
        { detector: 'bank', action: 'mask' },
        { detector: 'password', action: 'block' },
      ],
      masked: 'STK [STK_1] Vietcombank, mật khẩu: Abc@12345',
    });
  });
});
