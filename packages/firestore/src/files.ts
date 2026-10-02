import {
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import type { FileKind, FileStatus, FileView } from '@uniai/shared';
import { getAdminApp } from './admin.js';
import { COLLECTIONS } from './collections.js';

const DAY_MS = 24 * 3600_000;
/** Unfinished uploads: the Firestore record expires (TTL) and tmp/ objects are deleted by
 * the bucket lifecycle (infra/storage-lifecycle.json) after a day. */
const PENDING_TTL_MS = DAY_MS;

/** Object storage used for attachments (Cloud Storage; the emulator or memory in tests). */
export interface BlobStore {
  /** Signed PUT URL that only accepts `contentType` and at most `maxBytes`. */
  signedUploadUrl(
    path: string,
    contentType: string,
    maxBytes: number,
    expiresMs: number,
  ): Promise<{ url: string; headers: Record<string, string> }>;
  /** Size in bytes, or null when the object does not exist. */
  size(path: string): Promise<number | null>;
  read(path: string): Promise<Buffer>;
  write(path: string, data: Buffer | string, contentType: string): Promise<void>;
  /** Deleting a missing object is not an error. */
  delete(path: string): Promise<void>;
}

export class GcsBlobStore implements BlobStore {
  constructor(private readonly bucketName: string) {}

  private file(path: string) {
    return getStorage(getAdminApp()).bucket(this.bucketName).file(path);
  }

  async signedUploadUrl(path: string, contentType: string, maxBytes: number, expiresMs: number) {
    const range = `0,${maxBytes}`;
    // On Cloud Run this signs through the IAM Credentials API (infra/storage.sh grants it).
    const [url] = await this.file(path).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + expiresMs,
      contentType,
      extensionHeaders: { 'x-goog-content-length-range': range },
    });
    return { url, headers: { 'Content-Type': contentType, 'x-goog-content-length-range': range } };
  }

  async size(path: string) {
    try {
      const [meta] = await this.file(path).getMetadata();
      return Number(meta.size ?? 0);
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }

  async read(path: string) {
    const [data] = await this.file(path).download();
    return data;
  }

  async write(path: string, data: Buffer | string, contentType: string) {
    await this.file(path).save(data, { contentType, resumable: false });
  }

  async delete(path: string) {
    await this.file(path).delete({ ignoreNotFound: true });
  }
}

/** In-memory BlobStore for unit tests. */
export class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, { data: Buffer; contentType: string }>();

  signedUploadUrl(path: string, contentType: string, maxBytes: number) {
    return Promise.resolve({
      url: `https://storage.test/${encodeURIComponent(path)}`,
      headers: { 'Content-Type': contentType, 'x-goog-content-length-range': `0,${maxBytes}` },
    });
  }
  size(path: string) {
    return Promise.resolve(this.objects.get(path)?.data.length ?? null);
  }
  read(path: string) {
    const o = this.objects.get(path);
    return o ? Promise.resolve(o.data) : Promise.reject(new Error(`Không có ${path}`));
  }
  write(path: string, data: Buffer | string, contentType: string) {
    this.objects.set(path, { data: Buffer.from(data), contentType });
    return Promise.resolve();
  }
  delete(path: string) {
    this.objects.delete(path);
    return Promise.resolve();
  }
}

/** files/{id}: what the API knows about one upload. */
export interface FileRecord extends FileView {
  ownerUid: string;
  /** Where the browser uploads (tmp/…, deleted after a day). */
  uploadPath: string;
  /** Kept content: the image itself, or the extracted text (…txt). Null until ready. */
  storagePath: string | null;
}

const iso = (t: unknown) =>
  t instanceof Timestamp ? t.toDate().toISOString() : new Date(0).toISOString();

function toRecord(snap: DocumentSnapshot): FileRecord {
  const d = snap.data() ?? {};
  return {
    id: snap.id,
    ownerUid: d.ownerUid,
    name: d.name,
    mime: d.mime,
    kind: d.kind,
    size: d.size ?? 0,
    status: d.status,
    pages: d.pages ?? null,
    chars: d.chars ?? null,
    truncated: d.truncated === true,
    error: d.error ?? null,
    uploadPath: d.uploadPath,
    storagePath: d.storagePath ?? null,
    createdAt: iso(d.createdAt),
  };
}

export function toFileView(r: FileRecord): FileView {
  return {
    id: r.id,
    name: r.name,
    mime: r.mime,
    kind: r.kind,
    size: r.size,
    status: r.status,
    pages: r.pages,
    chars: r.chars,
    truncated: r.truncated,
    error: r.error,
    createdAt: r.createdAt,
  };
}

/**
 * Attachment records (spec 9: files/{id}). Objects live under
 * tmp/{env}/{uid}/{id} while uploading and files/{env}/{uid}/{id}[.txt] once checked;
 * `env` keeps staging and production apart in the shared bucket.
 */
export class FileStore {
  constructor(
    private readonly db: Firestore,
    private readonly env: string,
  ) {}

  private col() {
    return this.db.collection(COLLECTIONS.files);
  }

  keptPath(r: Pick<FileRecord, 'ownerUid' | 'id' | 'kind'>): string {
    const base = `files/${this.env}/${r.ownerUid}/${r.id}`;
    return r.kind === 'image' ? base : `${base}.txt`;
  }

  async create(input: {
    ownerUid: string;
    name: string;
    mime: string;
    kind: FileKind;
    size: number;
  }): Promise<FileRecord> {
    const ref = this.col().doc();
    const uploadPath = `tmp/${this.env}/${input.ownerUid}/${ref.id}`;
    const now = Timestamp.now();
    await ref.create({
      ...input,
      status: 'pending' satisfies FileStatus,
      pages: null,
      chars: null,
      truncated: false,
      error: null,
      uploadPath,
      storagePath: null,
      scanStatus: 'not_scanned',
      createdAt: now,
      expireAt: Timestamp.fromMillis(now.toMillis() + PENDING_TTL_MS),
    });
    return toRecord(await ref.get());
  }

  /** The caller's file, or null (also for other people's files). */
  async get(id: string, ownerUid: string): Promise<FileRecord | null> {
    const snap = await this.col().doc(id).get();
    if (!snap.exists || snap.get('ownerUid') !== ownerUid) return null;
    return toRecord(snap);
  }

  /** The caller's files in the given order; missing or foreign ids are left out. */
  async getMany(ids: string[], ownerUid: string): Promise<FileRecord[]> {
    if (ids.length === 0) return [];
    const snaps = await this.db.getAll(...ids.map((id) => this.col().doc(id)));
    return snaps.filter((s) => s.exists && s.get('ownerUid') === ownerUid).map(toRecord);
  }

  async markReady(
    id: string,
    result: { storagePath: string; pages: number | null; chars: number | null; truncated: boolean },
    retentionDays: number,
  ) {
    await this.col()
      .doc(id)
      .update({
        ...result,
        status: 'ready' satisfies FileStatus,
        error: null,
        readyAt: FieldValue.serverTimestamp(),
        expireAt: Timestamp.fromMillis(Date.now() + retentionDays * DAY_MS),
      });
  }

  async markFailed(id: string, error: string) {
    await this.col()
      .doc(id)
      .update({ status: 'failed' satisfies FileStatus, error });
  }

  async delete(id: string) {
    await this.col().doc(id).delete();
  }
}
