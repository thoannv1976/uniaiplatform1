import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { MemorySecretStore, NormalizedChatRequest } from '@uniai/ai-providers';
import { getDb } from '@uniai/firestore';
import {
  agentStreamEventSchema,
  appClientKeyResponseSchema,
  usdToMicro,
  type AgentStreamEvent,
} from '@uniai/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { audit, givenUser, resetData, startApp, tokenFor } from '../test/harness.js';

let app: INestApplication;
let requests: NormalizedChatRequest[];
let secrets: MemorySecretStore;
const http = () => request(app.getHttpServer());

/** A stand-in for a university LMS: records calls, answers with the body set per test. */
let lms: Server;
let lmsUrl = '';
const lmsCalls: { url: string; headers: IncomingHttpHeaders }[] = [];
let lmsBody = '';
let lmsStatus = 200;

const COURSE = JSON.stringify({ id: 'KT101', name: 'Kinh tế vi mô', credits: 3 });

async function sse(path: string, auth: string, body: unknown) {
  const res = await http()
    .post(path)
    .set('Authorization', auth)
    .send(body as object)
    .buffer(true)
    .parse((r, cb) => {
      let data = '';
      r.setEncoding('utf8');
      r.on('data', (c: string) => (data += c));
      r.on('end', () => cb(null, data));
    });
  const events: AgentStreamEvent[] =
    res.status === 200
      ? (res.body as string)
          .split('\n\n')
          .map((b) => b.split('\n').find((l) => l.startsWith('data: ')))
          .filter((l): l is string => !!l)
          .map((l) => agentStreamEventSchema.parse(JSON.parse(l.slice(6))))
      : [];
  const answer = events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('');
  return { status: res.status, events, answer, body: res.body as unknown };
}

const run = (who: string, agentId: string, content: string) =>
  sse(`/api/agents/${agentId}/run`, tokenFor(who), { messages: [{ role: 'user', content }] });

async function setupLms(over: Record<string, unknown> = {}) {
  const res = await http()
    .put('/api/admin/integrations/lms')
    .set('Authorization', tokenFor('ai'))
    .send({
      name: 'LMS thử nghiệm',
      type: 'lms',
      description: '',
      baseUrl: `${lmsUrl}/api`,
      authType: 'bearer',
      authHeader: null,
      sendActor: true,
      timeoutMs: 5000,
      status: 'active',
      operations: [
        {
          id: 'get_course',
          name: 'Học phần',
          description: 'Thông tin học phần theo mã',
          method: 'GET',
          path: '/courses/{courseId}',
          parameters: [
            { name: 'courseId', in: 'path', type: 'string', description: 'Mã', required: true },
          ],
        },
      ],
      ...over,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await http()
    .post('/api/admin/integrations/lms/token')
    .set('Authorization', tokenFor('ai'))
    .send({ token: 'lms-test-token-1234' })
    .expect(204);
}

async function createAgent(over: Record<string, unknown> = {}) {
  const res = await http()
    .post('/api/admin/agents')
    .set('Authorization', tokenFor('ai'))
    .send({
      name: 'Trợ lý học vụ',
      description: 'Tra cứu học phần',
      instructions: 'Bạn là trợ lý học vụ. Dùng công cụ khi cần.',
      model: 'auto',
      tools: ['lms.get_course', 'current_datetime'],
      knowledgeBaseIds: [],
      publishedTo: [],
      allowApps: false,
      maxSteps: 3,
      status: 'active',
      ...over,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string };
}

beforeAll(async () => {
  lms = createServer((req, res) => {
    lmsCalls.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(lmsStatus, { 'Content-Type': 'application/json' });
    res.end(lmsBody);
  });
  await new Promise<void>((resolve) => lms.listen(0, '127.0.0.1', resolve));
  lmsUrl = `http://127.0.0.1:${(lms.address() as AddressInfo).port}`;
  let s;
  ({ app, requests, secrets: s } = await startApp());
  secrets = s as MemorySecretStore;
});
afterAll(async () => {
  await app?.close();
  await new Promise((resolve) => lms?.close(resolve));
});
beforeEach(async () => {
  await resetData();
  requests.length = 0;
  lmsCalls.length = 0;
  lmsBody = COURSE;
  lmsStatus = 200;
  await givenUser(app, 'ai', 'ai_admin');
  await givenUser(app, 'au', 'auditor');
  await givenUser(app, 'gv', 'user', 'active', { departmentId: 'KTQT' });
  await setupLms();
});

describe('agents with an integration', () => {
  it('calls the LMS as a tool, answers with its data and bills every step', async () => {
    const agent = await createAgent();
    const r = await run(
      'gv',
      agent.id,
      'KT101 mấy tín chỉ? [mock:tool=lms.get_course {"courseId":"KT101"}]',
    );
    expect(r.status).toBe(200);
    expect(r.events[0]).toMatchObject({ type: 'meta', agent: { name: 'Trợ lý học vụ' } });
    expect(r.events.find((e) => e.type === 'tool')).toMatchObject({
      tool: 'lms.get_course',
      arguments: { courseId: 'KT101' },
      status: 'ok',
    });
    expect(r.answer).toContain('Kinh tế vi mô');
    const done = r.events.at(-1);
    expect(done).toMatchObject({ type: 'done', steps: 2, stopReason: 'answer' });
    // The LMS got the token, the acting user and the right path.
    expect(lmsCalls).toHaveLength(1);
    expect(lmsCalls[0]).toMatchObject({
      url: '/api/courses/KT101',
      headers: { authorization: 'Bearer lms-test-token-1234', 'x-uniai-actor': 'gv@ftu.edu.vn' },
    });
    // The model saw the tools and the result, and both steps are in the ledger.
    expect(requests[0]?.messages[0]?.content).toContain('- lms.get_course: [LMS thử nghiệm]');
    expect(requests[1]?.messages.at(-1)?.content).toContain(
      '<tool_result tool="lms.get_course" status="ok">',
    );
    const ledger = await getDb()
      .collection('usageTransactions')
      .where('agentId', '==', agent.id)
      .get();
    expect(ledger.size).toBe(2);
    const total = ledger.docs.reduce((s, d) => s + (d.get('totalCost') as number), 0);
    expect(done?.type === 'done' && done.cost).toBe(total);
    expect(ledger.docs.map((d) => d.get('routeReason') as string).sort()[0]).toContain(
      'Agent "Trợ lý học vụ" – bước 1',
    );
    // The token lives in the secret store only; the audit has no arguments or data.
    expect(secrets.versions.get('integration-lms-token')).toEqual(['lms-test-token-1234']);
    const logs = JSON.stringify(await audit().list());
    expect(logs).not.toContain('lms-test-token-1234');
    expect(logs).not.toContain('Kinh tế vi mô');
    expect(logs).toContain('INTEGRATION_CALL');
    expect(logs).toContain('AGENT_RUN');
  });

  it('screens tool results with DLP and stops at the step limit', async () => {
    const agent = await createAgent();
    lmsBody = JSON.stringify({ lecturer: 'Nguyễn A', cccd: '001203004567' });
    const masked = await run(
      'gv',
      agent.id,
      'Giảng viên? [mock:tool=lms.get_course {"courseId":"KT101"}]',
    );
    expect(JSON.stringify(requests)).not.toContain('001203004567');
    expect(JSON.stringify(requests)).toContain('[CCCD_1]');
    expect(masked.answer).toContain('001203004567');

    // A value masked in the user's message reaches the university's system unmasked.
    lmsCalls.length = 0;
    lmsBody = JSON.stringify({ name: 'Kinh tế vi mô' });
    await run(
      'gv',
      agent.id,
      'Học phần của 001203004567? [mock:tool=lms.get_course {"courseId":"001203004567"}]',
    );
    expect(lmsCalls[0]?.url).toBe('/api/courses/001203004567');
    expect(JSON.stringify(requests)).not.toContain('001203004567');

    requests.length = 0;
    lmsBody = JSON.stringify({ note: 'mật khẩu: Xyz#98765' });
    const blocked = await run(
      'gv',
      agent.id,
      'Ghi chú? [mock:tool=lms.get_course {"courseId":"KT101"}]',
    );
    expect(blocked.events.find((e) => e.type === 'tool')).toMatchObject({ status: 'denied' });
    expect(JSON.stringify(requests)).not.toContain('Xyz#98765');

    // A system answer that makes the model call again: the loop ends at maxSteps (3).
    lmsBody = 'Xem thêm [mock:tool=lms.get_course {"courseId":"KT102"}]';
    const loop = await run(
      'gv',
      agent.id,
      'Tra cứu [mock:tool=lms.get_course {"courseId":"KT101"}]',
    );
    expect(loop.events.at(-1)).toMatchObject({ type: 'done', steps: 3, stopReason: 'max_steps' });
    expect(loop.answer).toContain('hết 3 bước');
  });

  it('reports bad arguments, unknown tools and system errors to the model', async () => {
    const agent = await createAgent();
    const dots = await run('gv', agent.id, 'X [mock:tool=lms.get_course {"courseId":".."}]');
    expect(dots.events.find((e) => e.type === 'tool')).toMatchObject({ status: 'error' });
    expect(lmsCalls).toHaveLength(0);
    const unknown = await run('gv', agent.id, 'X [mock:tool=erp.salary {}]');
    expect(unknown.events.find((e) => e.type === 'tool')).toMatchObject({ status: 'denied' });
    lmsStatus = 500;
    const down = await run('gv', agent.id, 'X [mock:tool=lms.get_course {"courseId":"KT9"}]');
    expect(down.events.find((e) => e.type === 'tool')).toMatchObject({
      status: 'error',
      message: 'Hệ thống tích hợp trả lỗi HTTP 500.',
    });
    expect(down.events.at(-1)).toMatchObject({ type: 'done', stopReason: 'answer' });
  });

  it('shows agents by unit and validates configurations', async () => {
    const agent = await createAgent({ publishedTo: ['QTKD'] });
    const mine = await http().get('/api/agents').set('Authorization', tokenFor('gv')).expect(200);
    expect(mine.body.agents).toEqual([]);
    expect((await run('gv', agent.id, 'Xin chào')).status).toBe(404);
    const admin = await http().get('/api/agents').set('Authorization', tokenFor('ai')).expect(200);
    expect(admin.body.agents.map((a: { id: string }) => a.id)).toEqual([agent.id]);

    const badTool = await http()
      .post('/api/admin/agents')
      .set('Authorization', tokenFor('ai'))
      .send({
        name: 'X',
        description: '',
        instructions: 'x',
        model: 'auto',
        tools: ['lms.delete_course'],
        knowledgeBaseIds: [],
        publishedTo: [],
        allowApps: false,
        maxSteps: 2,
        status: 'active',
      });
    expect(badTool.status).toBe(400);
    const external = await http()
      .put('/api/admin/integrations/erp')
      .set('Authorization', tokenFor('ai'))
      .send({
        name: 'ERP',
        type: 'erp',
        description: '',
        baseUrl: 'http://erp.example.edu.vn',
        authType: 'none',
        authHeader: null,
        sendActor: false,
        timeoutMs: 5000,
        status: 'active',
        operations: [],
      });
    expect(external.status).toBe(400);
    expect(external.body.message).toContain('https://');

    const list = await http()
      .get('/api/admin/integrations')
      .set('Authorization', tokenFor('au'))
      .expect(200);
    expect(list.body.integrations[0]).toMatchObject({ id: 'lms', tokenLast4: '1234' });
    expect(JSON.stringify(list.body)).not.toContain('lms-test-token');
  });

  it('tests an operation for the administrator with values masked', async () => {
    lmsBody = JSON.stringify({ id: 'KT101', cccd: '001203004567' });
    const res = await http()
      .post('/api/admin/integrations/lms/operations/get_course/test')
      .set('Authorization', tokenFor('ai'))
      .send({ arguments: { courseId: 'KT101' } })
      .expect(200);
    expect(res.body).toMatchObject({ ok: true, status: 200 });
    expect(res.body.preview).toContain('[CCCD_1]');
    expect(res.body.preview).not.toContain('001203004567');
  });
});

describe('agents over the Platform API', () => {
  it('runs agents opened to apps, billed to the app', async () => {
    await givenUser(app, 'sa', 'super_admin');
    const open = await createAgent({ allowApps: true });
    const closed = await createAgent({ name: 'Nội bộ', allowApps: false });
    const created = await http()
      .post('/api/admin/app-clients')
      .set('Authorization', tokenFor('sa'))
      .send({
        name: 'LMS',
        ownerDepartmentId: 'KTQT',
        scopes: ['agents'],
        monthlyBudget: usdToMicro(1),
      });
    const { client, key } = appClientKeyResponseSchema.parse(created.body);
    const auth = `Bearer ${key}`;
    const list = await http().get('/api/platform/v1/agents').set('Authorization', auth).expect(200);
    expect(list.body.agents.map((a: { id: string }) => a.id)).toEqual([open.id]);

    const r = await sse(`/api/platform/v1/agents/${open.id}/run`, auth, {
      messages: [
        { role: 'user', content: 'Học phần? [mock:tool=lms.get_course {"courseId":"KT101"}]' },
      ],
      reference: 'lms:agent-1',
    });
    expect(r.status).toBe(200);
    expect(r.answer).toContain('Kinh tế vi mô');
    expect(lmsCalls[0]?.headers['x-uniai-actor']).toBe(`app:${client.id}`);
    const ledger = await getDb()
      .collection('usageTransactions')
      .where('appClientId', '==', client.id)
      .get();
    expect(ledger.docs.map((d) => d.get('agentId'))).toEqual([open.id, open.id]);
    expect(ledger.docs[0]?.get('reference')).toBe('lms:agent-1');

    expect(
      (
        await sse(`/api/platform/v1/agents/${closed.id}/run`, auth, {
          messages: [{ role: 'user', content: 'x' }],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await http()
          .post('/api/platform/v1/chat')
          .set('Authorization', auth)
          .send({ messages: [{ role: 'user', content: 'x' }] })
      ).status,
    ).toBe(403);
  });
});
