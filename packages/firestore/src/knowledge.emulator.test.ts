import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from './admin.js';
import { KnowledgeStore } from './knowledge.js';
import { clearFirestoreEmulator } from './testing.js';

const db = getDb();
const store = new KnowledgeStore(db, 'staging');
const unit = (i: number, dims = 8) => Array.from({ length: dims }, (_, j) => (j === i ? 1 : 0.01));

beforeEach(async () => {
  await clearFirestoreEmulator();
});

describe('KnowledgeStore', () => {
  it('creates bases and versions, stores chunks, searches per base and retires old versions', async () => {
    const kb = await store.createKb({ name: 'Quy chế', description: '', aclScopeId: null }, 'ai');
    const other = await store.createKb(
      { name: 'Khoa KTQT', description: '', aclScopeId: 'KTQT' },
      'ai',
    );
    expect(kb).toMatchObject({ active: true, documentCount: 0 });

    const v1 = await store.createDocument({
      kbId: kb.id,
      title: 'Quy chế đào tạo',
      fileName: 'qc.pdf',
      mime: 'application/pdf',
      size: 10,
      effectiveDate: '2026-09-01',
      replacesId: null,
      uploadedBy: 'ai',
    });
    expect(v1).toMatchObject({
      version: 1,
      status: 'uploading',
      sourcePath: `kb/staging/${kb.id}/${v1.id}`,
    });
    expect(await store.claim(v1.id, ['uploading'], 'queued')).toBe(true);
    expect(await store.claim(v1.id, ['uploading'], 'queued')).toBe(false);
    await store.completeDocument(
      v1,
      [
        { index: 0, page: 1, text: 'Điều 1', embedding: unit(0) },
        { index: 1, page: 2, text: 'Điều 2', embedding: unit(1) },
      ],
      2,
    );
    const otherDoc = await store.createDocument({
      kbId: other.id,
      title: 'Nội bộ khoa',
      fileName: 'a.txt',
      mime: 'text/plain',
      size: 1,
      effectiveDate: null,
      replacesId: null,
      uploadedBy: 'ai',
    });
    await store.completeDocument(
      otherDoc,
      [{ index: 0, page: null, text: 'Bí mật', embedding: unit(1) }],
      null,
    );

    const hits = await store.search([kb.id], unit(1), 5);
    expect(hits.map((h) => h.text)).toEqual(['Điều 2', 'Điều 1']);
    expect(hits[0]).toMatchObject({ documentId: v1.id, page: 2, version: 1 });
    expect(hits[0]!.distance).toBeLessThan(hits[1]!.distance);
    expect((await store.search([kb.id, other.id], unit(1), 5)).map((h) => h.text)).toContain(
      'Bí mật',
    );
    expect((await store.getKb(kb.id))?.documentCount).toBe(1);

    await expect(
      store.createDocument({ ...v1, kbId: other.id, replacesId: v1.id, uploadedBy: 'ai' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const v2 = await store.createDocument({
      kbId: kb.id,
      title: 'Quy chế đào tạo',
      fileName: 'qc2.pdf',
      mime: 'application/pdf',
      size: 10,
      effectiveDate: '2027-01-01',
      replacesId: v1.id,
      uploadedBy: 'ai',
    });
    expect(v2.version).toBe(2);
    await store.completeDocument(
      v2,
      [{ index: 0, page: 1, text: 'Điều 1 mới', embedding: unit(0) }],
      1,
    );
    expect((await store.getDocument(v1.id))?.status).toBe('superseded');
    expect((await store.search([kb.id], unit(0), 5)).map((h) => h.text)).toEqual(['Điều 1 mới']);
    expect((await store.listDocuments(kb.id)).map((d) => d.version)).toEqual([2, 1]);

    await store.deleteDocument(v2.id);
    expect(await store.search([kb.id], unit(0), 5)).toEqual([]);
    expect((await store.getKb(kb.id))?.documentCount).toBe(0);
  });
});
