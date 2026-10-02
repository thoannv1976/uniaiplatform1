import {
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase-admin/firestore';
import type {
  CreateKnowledgeBaseRequest,
  KbDocument,
  KbDocumentStatus,
  KnowledgeBase,
  UpdateKnowledgeBaseRequest,
} from '@uniai/shared';
import { COLLECTIONS } from './collections.js';

const iso = (t: unknown) => (t instanceof Timestamp ? t.toDate().toISOString() : null);

function toKb(snap: DocumentSnapshot): KnowledgeBase {
  const d = snap.data() ?? {};
  return {
    id: snap.id,
    name: d.name ?? '',
    description: d.description ?? '',
    aclScopeId: d.aclScopeId ?? null,
    active: d.active !== false,
    documentCount: d.documentCount ?? 0,
    createdAt: iso(d.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(d.updatedAt) ?? new Date(0).toISOString(),
  };
}

/** documents/{id} plus where its source file is stored. */
export interface KbDocumentRecord extends KbDocument {
  sourcePath: string;
}

function toDoc(snap: DocumentSnapshot): KbDocumentRecord {
  const d = snap.data() ?? {};
  return {
    id: snap.id,
    kbId: d.kbId,
    title: d.title ?? '',
    version: d.version ?? 1,
    effectiveDate: d.effectiveDate ?? null,
    status: d.status,
    fileName: d.fileName ?? '',
    mime: d.mime ?? '',
    size: d.size ?? 0,
    pages: d.pages ?? null,
    chunkCount: d.chunkCount ?? 0,
    error: d.error ?? null,
    replacesId: d.replacesId ?? null,
    uploadedBy: d.uploadedBy ?? '',
    createdAt: iso(d.createdAt) ?? new Date(0).toISOString(),
    readyAt: iso(d.readyAt),
    sourcePath: d.sourcePath,
  };
}

export function toKbDocumentView(r: KbDocumentRecord): KbDocument {
  return Object.fromEntries(
    Object.entries(r).filter(([key]) => key !== 'sourcePath'),
  ) as unknown as KbDocument;
}

/** A stored chunk returned by a vector search. */
export interface ChunkHit {
  id: string;
  kbId: string;
  documentId: string;
  title: string;
  version: number;
  effectiveDate: string | null;
  index: number;
  page: number | null;
  text: string;
  /** Cosine distance (0 = identical). */
  distance: number;
}

export class KnowledgeError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'conflict' | 'invalid',
  ) {
    super(message);
  }
}

const WRITE_BATCH = 200;

/**
 * Knowledge bases, their documents and chunks (spec 9: knowledgeBases/{id}, documents/{id};
 * chunks/{id} with a vector field). Source files live in Cloud Storage under
 * kb/{env}/{kbId}/{documentId}.
 */
export class KnowledgeStore {
  constructor(
    private readonly db: Firestore,
    private readonly env: string,
  ) {}

  private kbs() {
    return this.db.collection(COLLECTIONS.knowledgeBases);
  }
  private docs() {
    return this.db.collection(COLLECTIONS.documents);
  }
  private chunks() {
    return this.db.collection(COLLECTIONS.chunks);
  }

  async listKbs(): Promise<KnowledgeBase[]> {
    const snap = await this.kbs().get();
    return snap.docs.map(toKb).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  }

  async getKb(id: string): Promise<KnowledgeBase | null> {
    const snap = await this.kbs().doc(id).get();
    return snap.exists ? toKb(snap) : null;
  }

  async createKb(input: CreateKnowledgeBaseRequest, by: string): Promise<KnowledgeBase> {
    const ref = this.kbs().doc();
    const now = FieldValue.serverTimestamp();
    await ref.create({
      ...input,
      active: true,
      documentCount: 0,
      createdBy: by,
      createdAt: now,
      updatedAt: now,
    });
    return toKb(await ref.get());
  }

  async updateKb(id: string, patch: UpdateKnowledgeBaseRequest): Promise<KnowledgeBase> {
    const ref = this.kbs().doc(id);
    if (!(await ref.get()).exists)
      throw new KnowledgeError('Không tìm thấy kho tri thức.', 'not_found');
    await ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
    return toKb(await ref.get());
  }

  async listDocuments(kbId: string): Promise<KbDocument[]> {
    const snap = await this.docs().where('kbId', '==', kbId).get();
    return snap.docs
      .map(toDoc)
      .map(toKbDocumentView)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getDocument(id: string): Promise<KbDocumentRecord | null> {
    const snap = await this.docs().doc(id).get();
    return snap.exists ? toDoc(snap) : null;
  }

  /** A new document (or a new version replacing `replacesId`), waiting for its upload. */
  async createDocument(input: {
    kbId: string;
    title: string;
    fileName: string;
    mime: string;
    size: number;
    effectiveDate: string | null;
    replacesId: string | null;
    uploadedBy: string;
  }): Promise<KbDocumentRecord> {
    let version = 1;
    if (input.replacesId) {
      const previous = await this.getDocument(input.replacesId);
      if (!previous || previous.kbId !== input.kbId) {
        throw new KnowledgeError('Không tìm thấy phiên bản trước trong kho này.', 'not_found');
      }
      if (previous.status !== 'ready') {
        throw new KnowledgeError('Chỉ thay được phiên bản đang sẵn sàng.', 'conflict');
      }
      version = previous.version + 1;
    }
    const ref = this.docs().doc();
    await ref.create({
      ...input,
      version,
      status: 'uploading' satisfies KbDocumentStatus,
      pages: null,
      chunkCount: 0,
      error: null,
      sourcePath: `kb/${this.env}/${input.kbId}/${ref.id}`,
      createdAt: FieldValue.serverTimestamp(),
      readyAt: null,
    });
    return toDoc(await ref.get());
  }

  async setStatus(id: string, status: KbDocumentStatus, error: string | null = null) {
    await this.docs().doc(id).update({ status, error, updatedAt: FieldValue.serverTimestamp() });
  }

  /** Moves a document from `from` to `to` only if it is still in `from` (one worker wins). */
  async claim(id: string, from: KbDocumentStatus[], to: KbDocumentStatus): Promise<boolean> {
    const ref = this.docs().doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || !from.includes(snap.get('status'))) return false;
      tx.update(ref, { status: to, error: null, updatedAt: FieldValue.serverTimestamp() });
      return true;
    });
  }

  private async deleteChunks(documentId: string) {
    for (;;) {
      const snap = await this.chunks()
        .where('documentId', '==', documentId)
        .limit(WRITE_BATCH)
        .get();
      if (snap.empty) return;
      const batch = this.db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }

  /**
   * Stores the chunks of a processed document, marks it ready, and retires the version it
   * replaces (its chunks are removed so search only sees the current text).
   */
  async completeDocument(
    doc: KbDocumentRecord,
    chunks: { index: number; page: number | null; text: string; embedding: number[] }[],
    pages: number | null,
  ) {
    await this.deleteChunks(doc.id);
    for (let i = 0; i < chunks.length; i += WRITE_BATCH) {
      const batch = this.db.batch();
      for (const c of chunks.slice(i, i + WRITE_BATCH)) {
        batch.create(this.chunks().doc(`${doc.id}_${String(c.index).padStart(5, '0')}`), {
          kbId: doc.kbId,
          documentId: doc.id,
          title: doc.title,
          version: doc.version,
          effectiveDate: doc.effectiveDate,
          index: c.index,
          page: c.page,
          text: c.text,
          embedding: FieldValue.vector(c.embedding),
        });
      }
      await batch.commit();
    }
    await this.docs()
      .doc(doc.id)
      .update({
        status: 'ready' satisfies KbDocumentStatus,
        error: null,
        pages,
        chunkCount: chunks.length,
        readyAt: FieldValue.serverTimestamp(),
      });
    if (doc.replacesId) {
      await this.deleteChunks(doc.replacesId);
      await this.docs()
        .doc(doc.replacesId)
        .update({ status: 'superseded' satisfies KbDocumentStatus, chunkCount: 0 });
    }
    await this.refreshCount(doc.kbId);
  }

  async deleteDocument(id: string): Promise<KbDocumentRecord | null> {
    const doc = await this.getDocument(id);
    if (!doc) return null;
    await this.deleteChunks(id);
    await this.docs().doc(id).delete();
    await this.refreshCount(doc.kbId);
    return doc;
  }

  private async refreshCount(kbId: string) {
    const ready = await this.docs()
      .where('kbId', '==', kbId)
      .where('status', '==', 'ready')
      .count()
      .get();
    await this.kbs().doc(kbId).update({
      documentCount: ready.data().count,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  /** Nearest chunks in the given knowledge bases (one vector query per base, merged). */
  async search(kbIds: string[], vector: number[], limit: number): Promise<ChunkHit[]> {
    const results = await Promise.all(
      kbIds.map((kbId) =>
        this.chunks()
          .where('kbId', '==', kbId)
          .findNearest({
            vectorField: 'embedding',
            queryVector: vector,
            limit,
            distanceMeasure: 'COSINE',
            distanceResultField: 'distance',
          })
          .get(),
      ),
    );
    return results
      .flatMap((snap) =>
        snap.docs.map((d) => ({
          id: d.id,
          kbId: d.get('kbId') as string,
          documentId: d.get('documentId') as string,
          title: d.get('title') as string,
          version: d.get('version') as number,
          effectiveDate: (d.get('effectiveDate') as string | null) ?? null,
          index: d.get('index') as number,
          page: (d.get('page') as number | null) ?? null,
          text: d.get('text') as string,
          distance: d.get('distance') as number,
        })),
      )
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }
}
