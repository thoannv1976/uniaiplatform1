import type { INestApplication } from '@nestjs/common';
import type { NormalizedChatRequest } from '@uniai/ai-providers';
import { ConversationStore, getDb, MemoryBlobStore } from '@uniai/firestore';
import {
  createFileResponseSchema,
  createSseParser,
  fileViewSchema,
  type ChatStreamEvent,
} from '@uniai/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { audit, givenUser, resetData, startApp, tokenFor } from '../test/harness.js';
import { SAMPLE_PNG, sampleDocx, samplePdf, sampleXlsx } from './fixtures.js';

let app: INestApplication;
let requests: NormalizedChatRequest[];
const http = () => request(app.getHttpServer());
const conversations = new ConversationStore(getDb());

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Register → PUT (local proxy) → complete; returns the complete response. */
async function upload(who: string, name: string, mime: string, data: Buffer) {
  const created = await http()
    .post('/api/files')
    .set('Authorization', tokenFor(who))
    .send({ name, mime, size: data.length });
  if (created.status !== 201) return created;
  const { file, upload: target } = createFileResponseSchema.parse(created.body);
  expect(target).toMatchObject({ url: `/api/files/${file.id}/content`, withAuth: true });
  await http()
    .put(target.url)
    .set('Authorization', tokenFor(who))
    .set('Content-Type', mime)
    .send(data)
    .expect(204);
  return http().post(`/api/files/${file.id}/complete`).set('Authorization', tokenFor(who));
}

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
  return { status: res.status, body: res.body as unknown, events };
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
  await givenUser(app, 'gv', 'user', 'active', { departmentId: 'KTQT-KTVM' });
  await givenUser(app, 'gv2', 'user', 'active', { departmentId: 'QTKD' });
});

describe('POST /api/files', () => {
  it('uploads, extracts and keeps a PDF for its owner only', async () => {
    const res = await upload('gv', 'Quy chế.pdf', PDF, samplePdf(['Dieu 1', 'Dieu 2']));
    expect(res.status).toBe(200);
    const file = fileViewSchema.parse(res.body);
    expect(file).toMatchObject({ status: 'ready', kind: 'pdf', pages: 2, truncated: false });
    expect(file.chars).toBeGreaterThan(10);

    // Completing again is harmless; other people see nothing.
    await http()
      .post(`/api/files/${file.id}/complete`)
      .set('Authorization', tokenFor('gv'))
      .expect(200);
    await http().get(`/api/files/${file.id}`).set('Authorization', tokenFor('gv')).expect(200);
    await http().get(`/api/files/${file.id}`).set('Authorization', tokenFor('gv2')).expect(404);
    await http().delete(`/api/files/${file.id}`).set('Authorization', tokenFor('gv2')).expect(404);

    const logged = (await audit().list()).find((l) => l.event === 'DOCUMENT_UPLOAD');
    expect(logged).toMatchObject({ actor: 'gv', target: `files/${file.id}` });
    expect(JSON.stringify(logged)).not.toContain('Quy chế');

    await http().delete(`/api/files/${file.id}`).set('Authorization', tokenFor('gv')).expect(204);
    await http().get(`/api/files/${file.id}`).set('Authorization', tokenFor('gv')).expect(404);
  });

  it('refuses unsupported types, oversize files, early completion and bad content', async () => {
    const create = (body: object) =>
      http().post('/api/files').set('Authorization', tokenFor('gv')).send(body);
    expect(
      (await create({ name: 'a.exe', mime: 'application/x-msdownload', size: 10 })).status,
    ).toBe(400);
    const big = await create({ name: 'a.pdf', mime: PDF, size: 21 * 1024 * 1024 });
    expect(big.status).toBe(413);
    expect(big.body.message).toContain('20,0 MB');
    expect((await create({ name: 'a.png', mime: 'image/png', size: 6 * 1024 * 1024 })).status).toBe(
      413,
    );

    const pending = createFileResponseSchema.parse(
      (await create({ name: 'a.pdf', mime: PDF, size: 100 })).body,
    );
    await http()
      .post(`/api/files/${pending.file.id}/complete`)
      .set('Authorization', tokenFor('gv'))
      .expect(409);

    const fake = await upload('gv', 'anh.png', 'image/png', Buffer.from('not really a png'));
    expect(fake.status).toBe(422);
    expect(fake.body.message).toContain('không khớp');
  });
});

describe('chat with attachments', () => {
  it('puts document text before the question and keeps it for follow-ups', async () => {
    const word = fileViewSchema.parse(
      (await upload('gv', 'quy-che.docx', DOCX, sampleDocx())).body,
    );
    const sheet = fileViewSchema.parse(
      (
        await upload(
          'gv',
          'diem.xlsx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          sampleXlsx(),
        )
      ).body,
    );

    const first = await chat('gv', { message: 'Tóm tắt giúp tôi', fileIds: [word.id, sheet.id] });
    expect(first.status).toBe(200);
    const sent = requests[0]!.messages.at(-1)!;
    expect(sent.content).toContain('<tệp tên="quy-che.docx">\nQuy chế đào tạo');
    expect(sent.content).toContain('Nguyễn Văn A\t\t8.5\tĐạt');
    expect(sent.content.endsWith('Tóm tắt giúp tôi')).toBe(true);

    const meta = first.events[0];
    if (meta?.type !== 'meta') throw new Error('no meta');
    const messages = await conversations.listMessages(meta.conversationId);
    expect(messages[0]?.attachments).toEqual([
      { id: word.id, name: 'quy-che.docx', kind: 'docx' },
      { id: sheet.id, name: 'diem.xlsx', kind: 'xlsx' },
    ]);
    // The stored message is what the user typed, not the file text.
    expect(messages[0]?.content).toBe('Tóm tắt giúp tôi');

    const followUp = await chat('gv', {
      conversationId: meta.conversationId,
      message: 'Điều 1 nói gì?',
    });
    expect(followUp.status).toBe(200);
    expect(requests[1]!.messages[1]!.content).toContain('Quy chế đào tạo');
  });

  it('sends images to a model that reads them (AUTO) and refuses others', async () => {
    const image = fileViewSchema.parse(
      (await upload('gv', 'bieu-do.png', 'image/png', SAMPLE_PNG)).body,
    );
    const res = await chat('gv', { message: 'Ảnh này là gì?', fileIds: [image.id] });
    expect(res.status).toBe(200);
    expect(res.events[0]).toMatchObject({ type: 'meta', model: { id: 'mock-advanced' } });
    expect(requests[0]!.messages.at(-1)!.images).toEqual([
      { mime: 'image/png', data: SAMPLE_PNG.toString('base64') },
    ]);

    const refused = await chat('gv', {
      message: 'Ảnh này là gì?',
      model: 'mock-economy',
      fileIds: [image.id],
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('không đọc được ảnh');
  });

  it("refuses other people's files and files that are not ready", async () => {
    const mine = fileViewSchema.parse((await upload('gv', 'a.pdf', PDF, samplePdf(['A']))).body);
    expect((await chat('gv2', { message: 'Đọc', fileIds: [mine.id] })).status).toBe(400);
    const pending = await http()
      .post('/api/files')
      .set('Authorization', tokenFor('gv'))
      .send({ name: 'b.pdf', mime: PDF, size: 100 });
    expect((await chat('gv', { message: 'Đọc', fileIds: [pending.body.file.id] })).status).toBe(
      400,
    );
    expect(requests).toHaveLength(0);
  });
});

describe('signed uploads (Cloud Run)', () => {
  it('returns a signed Cloud Storage URL limited to the declared size', async () => {
    const blobs = new MemoryBlobStore();
    const { app: signedApp } = await startApp({ FILE_UPLOAD_MODE: 'signed' }, { blobStore: blobs });
    try {
      const res = await request(signedApp.getHttpServer())
        .post('/api/files')
        .set('Authorization', tokenFor('gv'))
        .send({ name: 'a.pdf', mime: PDF, size: 1234 })
        .expect(201);
      const { file, upload: target } = createFileResponseSchema.parse(res.body);
      expect(target).toEqual({
        url: `https://storage.test/${encodeURIComponent(`tmp/production/gv/${file.id}`)}`,
        method: 'PUT',
        headers: { 'Content-Type': PDF, 'x-goog-content-length-range': '0,1234' },
        withAuth: false,
      });
      // The local proxy endpoint does not exist there.
      await request(signedApp.getHttpServer())
        .put(`/api/files/${file.id}/content`)
        .set('Authorization', tokenFor('gv'))
        .set('Content-Type', PDF)
        .send(Buffer.from('%PDF-'))
        .expect(404);
      // The browser uploads to Cloud Storage; complete() then reads it from there.
      await blobs.write(`tmp/production/gv/${file.id}`, samplePdf(['Signed']), PDF);
      const done = await request(signedApp.getHttpServer())
        .post(`/api/files/${file.id}/complete`)
        .set('Authorization', tokenFor('gv'))
        .expect(200);
      expect(done.body).toMatchObject({ status: 'ready', pages: 1 });
      expect(blobs.objects.has(`tmp/production/gv/${file.id}`)).toBe(false);
      expect(blobs.objects.get(`files/production/gv/${file.id}.txt`)?.data.toString()).toContain(
        'Signed',
      );
    } finally {
      await signedApp.close();
    }
  });
});
