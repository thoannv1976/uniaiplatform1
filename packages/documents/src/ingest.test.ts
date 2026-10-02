import { MockEmbedder } from '@uniai/ai-providers';
import type { KbDocumentRecord, KnowledgeStore } from '@uniai/firestore';
import { MemoryBlobStore } from '@uniai/firestore';
import { describe, expect, it, vi } from 'vitest';
import { samplePdf } from './fixtures.js';
import { ingestDocument } from './ingest.js';

function fakeStore(doc: Partial<KbDocumentRecord>) {
  const record = {
    id: 'd1',
    kbId: 'k1',
    title: 'Quy chế',
    version: 1,
    effectiveDate: null,
    status: 'queued',
    fileName: 'qc.pdf',
    mime: 'application/pdf',
    size: 1,
    pages: null,
    chunkCount: 0,
    error: null,
    replacesId: null,
    uploadedBy: 'ai',
    createdAt: '',
    readyAt: null,
    sourcePath: 'kb/test/k1/d1',
    ...doc,
  } as KbDocumentRecord;
  const store = {
    claim: vi.fn(() => Promise.resolve(record.status === 'queued')),
    getDocument: vi.fn(() => Promise.resolve(record)),
    completeDocument: vi.fn(() => Promise.resolve()),
    setStatus: vi.fn(() => Promise.resolve()),
  };
  return { store: store as unknown as KnowledgeStore, calls: store };
}

describe('ingestDocument', () => {
  it('extracts, chunks, embeds and stores', async () => {
    const blobs = new MemoryBlobStore();
    await blobs.write(
      'kb/test/k1/d1',
      samplePdf(['Dieu 1 bao luu', 'Dieu 2 hoc phi']),
      'application/pdf',
    );
    const { store, calls } = fakeStore({});
    const result = await ingestDocument(
      { store, blobs, embedder: new MockEmbedder(), maxPages: 100 },
      'd1',
    );
    expect(result).toEqual({ status: 'ready', chunks: 1 });
    const [, chunks, pages] = calls.completeDocument.mock.calls[0] as unknown as [
      unknown,
      { text: string; embedding: number[]; page: number }[],
      number,
    ];
    expect(pages).toBe(2);
    expect(chunks[0]!.text).toContain('Dieu 2 hoc phi');
    expect(chunks[0]!.embedding).toHaveLength(768);
  });

  it('fails unusable files without retry and skips documents not waiting', async () => {
    const blobs = new MemoryBlobStore();
    await blobs.write('kb/test/k1/d1', Buffer.from('not a pdf'), 'application/pdf');
    const { store, calls } = fakeStore({});
    const deps = { store, blobs, embedder: new MockEmbedder(), maxPages: 100 };
    expect(await ingestDocument(deps, 'd1')).toMatchObject({ status: 'failed' });
    expect(calls.setStatus).toHaveBeenCalledWith(
      'd1',
      'failed',
      expect.stringContaining('không khớp'),
    );
    const ready = fakeStore({ status: 'ready' });
    expect(await ingestDocument({ ...deps, store: ready.store }, 'd1')).toEqual({
      status: 'skipped',
    });
  });

  it('requeues and rethrows on temporary errors', async () => {
    const { store, calls } = fakeStore({});
    const blobs = new MemoryBlobStore(); // missing object → read error
    await expect(
      ingestDocument({ store, blobs, embedder: new MockEmbedder(), maxPages: 100 }, 'd1'),
    ).rejects.toThrow();
    expect(calls.setStatus).toHaveBeenCalledWith('d1', 'queued', expect.any(String));
  });
});
