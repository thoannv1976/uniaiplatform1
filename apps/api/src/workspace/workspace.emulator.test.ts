import type { INestApplication } from '@nestjs/common';
import type { NormalizedChatRequest } from '@uniai/ai-providers';
import { createSseParser, type ChatStreamEvent } from '@uniai/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { audit, givenUser, resetData, startApp, tokenFor } from '../test/harness.js';

let app: INestApplication;
let requests: NormalizedChatRequest[];
const http = () => request(app.getHttpServer());
const as = (who: string) => ({ Authorization: tokenFor(who) });

async function chat(who: string, body: Record<string, unknown>) {
  const res = await http()
    .post('/api/ai/chat')
    .set(as(who))
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
  return { status: res.status, events };
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
  await givenUser(app, 'gv-kt', 'user', 'active', { departmentId: 'KTQT-KTVM' });
  await givenUser(app, 'gv-qt', 'user', 'active', { departmentId: 'QTKD' });
  await givenUser(app, 'ai', 'ai_admin');
  await givenUser(app, 'ka', 'unit_admin', 'active', {
    departmentId: 'KTQT',
    scopeDepartmentId: 'KTQT',
  });
});

describe('prompt library', () => {
  it('keeps private prompts private and publishes shared prompts to units', async () => {
    const mine = await http()
      .post('/api/prompts')
      .set(as('gv-qt'))
      .send({ title: 'Đề cương', body: 'Soạn đề cương môn {{tên môn}} {{số tuần}} tuần' })
      .expect(201);
    expect(mine.body).toMatchObject({
      visibility: 'private',
      variables: ['tên môn', 'số tuần'],
      editable: true,
    });
    // Users cannot publish.
    await http()
      .post('/api/prompts')
      .set(as('gv-qt'))
      .send({ title: 'X', body: 'Y', visibility: 'shared' })
      .expect(403);

    const unit = await http()
      .post('/api/prompts')
      .set(as('ai'))
      .send({
        title: 'Prompt KTQT',
        body: 'Phân tích {{ngành}}',
        visibility: 'shared',
        publishedTo: ['KTQT'],
      })
      .expect(201);
    await http()
      .post('/api/prompts')
      .set(as('ai'))
      .send({ title: 'Prompt chung', body: 'Dịch {{đoạn văn}}', visibility: 'shared' })
      .expect(201);
    // Unit admins publish only inside their unit.
    await http()
      .post('/api/prompts')
      .set(as('ka'))
      .send({ title: 'Ngoài', body: 'Z', visibility: 'shared', publishedTo: ['QTKD'] })
      .expect(403);
    await http()
      .post('/api/prompts')
      .set(as('ka'))
      .send({ title: 'Bộ môn', body: 'Z', visibility: 'shared', publishedTo: ['KTQT-KTVM'] })
      .expect(201);

    const titles = async (who: string) =>
      (await http().get('/api/prompts').set(as(who)).expect(200)).body.prompts
        .map((p: { title: string }) => p.title)
        .sort();
    expect(await titles('gv-kt')).toEqual(['Bộ môn', 'Prompt KTQT', 'Prompt chung']);
    expect(await titles('gv-qt')).toEqual(['Prompt chung', 'Đề cương']);

    // Shared prompts are read-only to users; other people's private ones look missing.
    await http()
      .patch(`/api/prompts/${unit.body.id}`)
      .set(as('gv-kt'))
      .send({ title: 'x' })
      .expect(403);
    await http().delete(`/api/prompts/${mine.body.id}`).set(as('gv-kt')).expect(404);
    await http()
      .patch(`/api/prompts/${mine.body.id}`)
      .set(as('gv-qt'))
      .send({ body: 'Mới {{a}}' })
      .expect(200)
      .expect((r) => expect(r.body.variables).toEqual(['a']));
    await http().delete(`/api/prompts/${mine.body.id}`).set(as('gv-qt')).expect(204);

    const published = (await audit().list()).filter(
      (l) => l.event === 'ADMIN_CHANGE' && l.metadata.action === 'publish_prompt',
    );
    expect(published).toHaveLength(3);
  });
});

describe('projects and my files', () => {
  async function uploadText(who: string, name: string, text: string) {
    const created = await http()
      .post('/api/files')
      .set(as(who))
      .send({ name, mime: 'text/plain', size: Buffer.byteLength(text) })
      .expect(201);
    await http()
      .put(created.body.upload.url)
      .set(as(who))
      .set('Content-Type', 'text/plain')
      .send(Buffer.from(text))
      .expect(204);
    await http().post(`/api/files/${created.body.file.id}/complete`).set(as(who)).expect(200);
    return created.body.file.id as string;
  }

  it('lists my files and gives project instructions and files to every conversation', async () => {
    const fileId = await uploadText('gv-qt', 'syllabus.txt', 'Môn Marketing quốc tế, 3 tín chỉ');
    const files = await http().get('/api/files').set(as('gv-qt')).expect(200);
    expect(files.body.files.map((f: { id: string }) => f.id)).toEqual([fileId]);
    expect((await http().get('/api/files').set(as('gv-kt')).expect(200)).body.files).toEqual([]);

    await http()
      .post('/api/projects')
      .set(as('gv-kt'))
      .send({ name: 'Mượn tệp', fileIds: [fileId] })
      .expect(400);
    const project = await http()
      .post('/api/projects')
      .set(as('gv-qt'))
      .send({
        name: 'Đề cương 2027',
        instructions: 'Luôn trả lời theo mẫu của khoa.',
        fileIds: [fileId],
      })
      .expect(201);
    await http()
      .get('/api/projects')
      .set(as('gv-kt'))
      .expect(200)
      .expect((r) => expect(r.body.projects).toEqual([]));
    await http()
      .patch(`/api/projects/${project.body.id}`)
      .set(as('gv-kt'))
      .send({ name: 'x' })
      .expect(404);

    const first = await chat('gv-qt', { message: 'Soạn tuần 1', projectId: project.body.id });
    expect(first.status).toBe(200);
    const system = requests[0]!.messages[0]!.content;
    expect(system).toContain('Bạn đang làm việc trong dự án "Đề cương 2027".');
    expect(system).toContain('Luôn trả lời theo mẫu của khoa.');
    expect(system).toContain('Môn Marketing quốc tế, 3 tín chỉ');

    const meta = first.events[0];
    if (meta?.type !== 'meta') throw new Error('no meta');
    const conv = await http()
      .get(`/api/conversations/${meta.conversationId}`)
      .set(as('gv-qt'))
      .expect(200);
    expect(conv.body.conversation.projectId).toBe(project.body.id);
    // Follow-ups keep the project context.
    await chat('gv-qt', { message: 'Tuần 2', conversationId: meta.conversationId });
    expect(requests[1]!.messages[0]!.content).toContain('Luôn trả lời theo mẫu của khoa.');

    // Someone else's project cannot be used.
    expect((await chat('gv-kt', { message: 'x', projectId: project.body.id })).status).toBe(404);

    // Deleting the project keeps its conversations, outside any project.
    await http().delete(`/api/projects/${project.body.id}`).set(as('gv-qt')).expect(204);
    const after = await http()
      .get(`/api/conversations/${meta.conversationId}`)
      .set(as('gv-qt'))
      .expect(200);
    expect(after.body.conversation.projectId).toBeNull();
  });

  it('moves conversations between projects', async () => {
    const p = await http().post('/api/projects').set(as('gv-qt')).send({ name: 'A' }).expect(201);
    const c = await http().post('/api/conversations').set(as('gv-qt')).send({}).expect(201);
    await http()
      .patch(`/api/conversations/${c.body.id}`)
      .set(as('gv-qt'))
      .send({ projectId: p.body.id })
      .expect(200)
      .expect((r) => expect(r.body.projectId).toBe(p.body.id));
    await http()
      .patch(`/api/conversations/${c.body.id}`)
      .set(as('gv-qt'))
      .send({ projectId: 'khongco' })
      .expect(404);
    await http()
      .post('/api/conversations')
      .set(as('gv-kt'))
      .send({ projectId: p.body.id })
      .expect(404);
  });
});
