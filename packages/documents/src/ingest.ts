import type { Embedder } from '@uniai/ai-providers';
import type { BlobStore, KnowledgeStore } from '@uniai/firestore';
import { fileTypeOf } from '@uniai/shared';
import { chunkText } from './chunk.js';
import { extract, FileContentError } from './extract.js';

export interface IngestDeps {
  store: KnowledgeStore;
  blobs: BlobStore;
  embedder: Embedder;
  maxPages: number;
}

export type IngestResult =
  { status: 'ready'; chunks: number } | { status: 'failed'; error: string } | { status: 'skipped' };

/**
 * Processes one knowledge-base document (spec 8.9): extract its text, cut ~800-token chunks
 * with 100 overlap, embed them and store them. Idempotent: a document no longer waiting is
 * skipped. Unusable files end as "failed" (no retry); other errors put the document back in
 * the queue and are rethrown so Cloud Tasks retries.
 */
export async function ingestDocument(deps: IngestDeps, documentId: string): Promise<IngestResult> {
  const { store } = deps;
  if (!(await store.claim(documentId, ['queued', 'processing'], 'processing'))) {
    return { status: 'skipped' };
  }
  const doc = (await store.getDocument(documentId))!;
  try {
    const type = fileTypeOf(doc.fileName, doc.mime);
    if (!type || type.kind === 'image') {
      throw new FileContentError(
        'Kho tri thức chỉ nhận PDF, Word, Excel, PowerPoint hoặc văn bản.',
      );
    }
    const data = await deps.blobs.read(doc.sourcePath);
    const result = await extract(type.kind, data, { maxPages: deps.maxPages });
    const chunks = chunkText(result.text ?? '');
    if (chunks.length === 0) throw new FileContentError('Tài liệu không có nội dung chữ.');
    const vectors = await deps.embedder.embed(
      chunks.map((c) => `${doc.title}\n${c.text}`),
      'document',
    );
    await store.completeDocument(
      doc,
      chunks.map((c, i) => ({ ...c, embedding: vectors[i]! })),
      result.pages,
    );
    return { status: 'ready', chunks: chunks.length };
  } catch (err) {
    if (err instanceof FileContentError) {
      await store.setStatus(documentId, 'failed', err.message);
      return { status: 'failed', error: err.message };
    }
    await store.setStatus(documentId, 'queued', 'Lỗi tạm thời, hệ thống sẽ thử lại.');
    throw err;
  }
}
