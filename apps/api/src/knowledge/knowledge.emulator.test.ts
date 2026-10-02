import type { INestApplication } from '@nestjs/common';
import { sampleDocx, samplePdf } from '@uniai/documents';
import { getDb, KnowledgeStore } from '@uniai/firestore';
import { MockEmbedder } from '@uniai/ai-providers';
import { createKbDocumentResponseSchema, kbDocumentSchema } from '@uniai/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { audit, givenUser, resetData, startApp, tokenFor } from '../test/harness.js';

let app: INestApplication;
const http = () => request(app.getHttpServer());
const store = new KnowledgeStore(getDb(), 'production');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function upload(
  kbId: string,
  title: string,
  fileName: string,
  mime: string,
  data: Buffer,
  extra = {},
) {
  const created = await http()
    .post(`/api/admin/knowledge-bases/${kbId}/documents`)
    .set('Authorization', tokenFor('ai'))
    .send({ title, fileName, mime, size: data.length, ...extra });
  expect(created.status).toBe(201);
  const { document, upload: target } = createKbDocumentResponseSchema.parse(created.body);
  await http()
    .put(target.url)
    .set('Authorization', tokenFor('ai'))
    .set('Content-Type', mime)
    .send(data)
    .expect(204);
  const done = await http()
    .post(`/api/admin/kb-documents/${document.id}/complete`)
    .set('Authorization', tokenFor('ai'))
    .expect(200);
  return kbDocumentSchema.parse(done.body);
}

beforeAll(async () => {
  ({ app } = await startApp());
});
afterAll(async () => {
  await app?.close();
});
beforeEach(async () => {
  await resetData();
  await givenUser(app, 'ai', 'ai_admin');
  await givenUser(app, 'au', 'auditor');
});

describe('knowledge base administration', () => {
  it('creates a base, ingests documents into searchable chunks and replaces versions', async () => {
    const kb = await http()
      .post('/api/admin/knowledge-bases')
      .set('Authorization', tokenFor('ai'))
      .send({ name: 'Quy chế đào tạo', description: 'Văn bản chính thức', aclScopeId: null })
      .expect(201);
    await http()
      .post('/api/admin/knowledge-bases')
      .set('Authorization', tokenFor('ai'))
      .send({ name: 'X', aclScopeId: 'KHONG-CO' })
      .expect(400);

    const v1 = await upload(
      kb.body.id,
      'Quy chế đào tạo',
      'quy-che.pdf',
      'application/pdf',
      samplePdf([
        'Sinh vien duoc bao luu ket qua hoc tap toi da hai nam',
        'Hoc phi dong theo hoc ky',
      ]),
      { effectiveDate: '2026-09-01' },
    );
    // Inline processing in tests: ready at once.
    expect(v1).toMatchObject({
      status: 'ready',
      version: 1,
      pages: 2,
      effectiveDate: '2026-09-01',
    });
    expect(v1.chunkCount).toBeGreaterThan(0);

    const [query] = await new MockEmbedder().embed(['bao luu ket qua hoc tap'], 'query');
    const hits = await store.search([kb.body.id], query!, 3);
    expect(hits[0]).toMatchObject({ documentId: v1.id, title: 'Quy chế đào tạo', page: 1 });

    const v2 = await upload(
      kb.body.id,
      'Quy chế đào tạo',
      'quy-che-2027.docx',
      DOCX,
      sampleDocx(),
      {
        replacesDocumentId: v1.id,
      },
    );
    expect(v2).toMatchObject({ status: 'ready', version: 2, replacesId: v1.id });
    const list = await http()
      .get(`/api/admin/knowledge-bases/${kb.body.id}/documents`)
      .set('Authorization', tokenFor('au'))
      .expect(200);
    expect(list.body.documents.map((d: { status: string }) => d.status)).toEqual([
      'ready',
      'superseded',
    ]);
    const kbs = await http().get('/api/admin/knowledge-bases').set('Authorization', tokenFor('au'));
    expect(kbs.body.knowledgeBases[0]).toMatchObject({ name: 'Quy chế đào tạo', documentCount: 1 });

    const events = (await audit().list()).filter((l) => l.event === 'KNOWLEDGE_UPDATE');
    expect(events.map((e) => e.metadata.action)).toEqual(
      expect.arrayContaining(['create_kb', 'upload_document']),
    );

    await http()
      .delete(`/api/admin/kb-documents/${v2.id}`)
      .set('Authorization', tokenFor('ai'))
      .expect(204);
    expect(await store.search([kb.body.id], query!, 3)).toEqual([]);
  });

  it('marks unusable files as failed, retries them, and refuses images and early completion', async () => {
    const kb = (
      await http()
        .post('/api/admin/knowledge-bases')
        .set('Authorization', tokenFor('ai'))
        .send({ name: 'Khoa', aclScopeId: 'KTQT' })
        .expect(201)
    ).body;
    const bad = await upload(
      kb.id,
      'Hỏng',
      'hong.pdf',
      'application/pdf',
      Buffer.from('not a pdf'),
    );
    expect(bad).toMatchObject({ status: 'failed' });
    expect(bad.error).toContain('không khớp');
    const retried = await http()
      .post(`/api/admin/kb-documents/${bad.id}/retry`)
      .set('Authorization', tokenFor('ai'))
      .expect(200);
    expect(retried.body.status).toBe('failed');
    await http()
      .post(`/api/admin/kb-documents/${bad.id}/retry`)
      .set('Authorization', tokenFor('ai'))
      .send()
      .expect(200);

    await http()
      .post(`/api/admin/knowledge-bases/${kb.id}/documents`)
      .set('Authorization', tokenFor('ai'))
      .send({ title: 'Ảnh', fileName: 'a.png', mime: 'image/png', size: 10 })
      .expect(400);
    const pending = await http()
      .post(`/api/admin/knowledge-bases/${kb.id}/documents`)
      .set('Authorization', tokenFor('ai'))
      .send({ title: 'Chưa tải', fileName: 'b.pdf', mime: 'application/pdf', size: 10 })
      .expect(201);
    await http()
      .post(`/api/admin/kb-documents/${pending.body.document.id}/complete`)
      .set('Authorization', tokenFor('ai'))
      .expect(409);
  });
});
