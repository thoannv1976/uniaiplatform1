import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ImageInput } from '@uniai/ai-providers';
import { toFileView, type BlobStore, type FileRecord, type FileStore } from '@uniai/firestore';
import {
  FILE_KIND_LABELS_VI,
  fileTypeOf,
  formatBytes,
  IMAGE_MAX_BYTES,
  type AttachmentRef,
  type CreateFileRequest,
  type CreateFileResponse,
  type FileView,
} from '@uniai/shared';
import { AuditService } from '../audit/audit.service.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { extract, FileContentError } from '@uniai/documents';

export const FILE_STORE = Symbol('FILE_STORE');
export const BLOB_STORE = Symbol('BLOB_STORE');

/** Signed upload URLs are short-lived. */
const UPLOAD_URL_TTL_MS = 15 * 60_000;

/** A file's content as the model will see it. */
export interface LoadedAttachment {
  ref: AttachmentRef;
  /** Extracted text (documents) – null for images and missing files. */
  text: string | null;
  truncated: boolean;
  image: ImageInput | null;
  /** False when the file is gone (expired or deleted). */
  available: boolean;
}

/**
 * Chat attachments (spec 8.3): issue an upload target, check and extract the upload, and
 * load contents for the chat. Files are private to their owner.
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger('Files');

  constructor(
    @Inject(FILE_STORE) private readonly files: FileStore,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  private maxBytes(kind: string) {
    return kind === 'image'
      ? Math.min(IMAGE_MAX_BYTES, this.config.fileMaxBytes)
      : this.config.fileMaxBytes;
  }

  async create(uid: string, req: CreateFileRequest): Promise<CreateFileResponse> {
    const type = fileTypeOf(req.name, req.mime);
    if (!type) {
      throw new BadRequestException(
        'Loại tệp không được hỗ trợ. Hãy dùng PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), văn bản (.txt, .md, .csv) hoặc ảnh (PNG, JPEG, WebP, GIF).',
      );
    }
    const max = this.maxBytes(type.kind);
    if (req.size > max) {
      throw new PayloadTooLargeException(
        `Tệp ${FILE_KIND_LABELS_VI[type.kind]} tối đa ${formatBytes(max)} (tệp này ${formatBytes(req.size)}).`,
      );
    }
    const record = await this.files.create({
      ownerUid: uid,
      name: req.name,
      mime: type.mime,
      kind: type.kind,
      size: req.size,
    });
    if (this.config.fileUploadMode === 'proxy') {
      return {
        file: toFileView(record),
        upload: {
          url: `/api/files/${record.id}/content`,
          method: 'PUT',
          headers: { 'Content-Type': type.mime },
          withAuth: true,
        },
      };
    }
    const signed = await this.blobs.signedUploadUrl(
      record.uploadPath,
      type.mime,
      req.size,
      UPLOAD_URL_TTL_MS,
    );
    return {
      file: toFileView(record),
      upload: { url: signed.url, method: 'PUT', headers: signed.headers, withAuth: false },
    };
  }

  private async own(uid: string, id: string): Promise<FileRecord> {
    const record = await this.files.get(id, uid);
    if (!record) throw new NotFoundException('Không tìm thấy tệp.');
    return record;
  }

  async get(uid: string, id: string): Promise<FileView> {
    return toFileView(await this.own(uid, id));
  }

  /** Local development only: the API stands in for the signed URL. */
  async receive(uid: string, id: string, body: unknown): Promise<void> {
    if (this.config.fileUploadMode !== 'proxy') throw new NotFoundException();
    const record = await this.own(uid, id);
    if (record.status !== 'pending') throw new ConflictException('Tệp đã được xử lý.');
    if (!Buffer.isBuffer(body) || body.length === 0) throw new BadRequestException('Tệp rỗng.');
    if (body.length > record.size)
      throw new PayloadTooLargeException('Tệp lớn hơn kích thước đã khai báo.');
    await this.blobs.write(record.uploadPath, body, record.mime);
  }

  /**
   * After the upload: checks size and content, extracts text, keeps the text (or the image)
   * under files/ and drops the upload. Calling it again returns the same result.
   */
  async complete(uid: string, id: string): Promise<FileView> {
    const record = await this.own(uid, id);
    if (record.status === 'ready') return toFileView(record);
    if (record.status === 'failed') {
      throw new UnprocessableEntityException(record.error ?? 'Tệp bị lỗi.');
    }
    const size = await this.blobs.size(record.uploadPath);
    if (size === null) throw new ConflictException('Chưa nhận được tệp. Vui lòng tải lên lại.');

    const fail = async (message: string): Promise<never> => {
      await this.files.markFailed(id, message);
      await this.blobs.delete(record.uploadPath).catch(() => undefined);
      throw new UnprocessableEntityException(message);
    };
    if (size > this.maxBytes(record.kind)) {
      return fail(`Tệp vượt giới hạn ${formatBytes(this.maxBytes(record.kind))}.`);
    }
    const data = await this.blobs.read(record.uploadPath);
    let result;
    try {
      result = await extract(record.kind, data, { maxPages: this.config.fileMaxPages });
    } catch (err) {
      if (err instanceof FileContentError) return fail(err.message);
      this.logger.error(`Lỗi trích nội dung tệp ${id}: ${String(err)}`);
      return fail('Không xử lý được tệp này.');
    }
    const storagePath = this.files.keptPath(record);
    if (result.text === null) await this.blobs.write(storagePath, data, record.mime);
    else await this.blobs.write(storagePath, result.text, 'text/plain; charset=utf-8');
    await this.blobs.delete(record.uploadPath).catch(() => undefined);
    await this.files.markReady(
      id,
      {
        storagePath,
        pages: result.pages,
        chars: result.text?.length ?? null,
        truncated: result.truncated,
      },
      this.config.conversationRetentionDays,
    );
    // File names stay out of the audit trail: they can be personal.
    await this.audit.record({
      event: 'DOCUMENT_UPLOAD',
      actor: uid,
      target: `files/${id}`,
      metadata: { kind: record.kind, size, pages: result.pages },
    });
    return toFileView((await this.files.get(id, uid))!);
  }

  async remove(uid: string, id: string): Promise<void> {
    const record = await this.own(uid, id);
    await Promise.all(
      [record.uploadPath, record.storagePath]
        .filter((p): p is string => p !== null)
        .map((p) => this.blobs.delete(p)),
    );
    await this.files.delete(id);
  }

  /** Files for a new message: all must be the caller's and ready. */
  async forMessage(uid: string, ids: string[]): Promise<LoadedAttachment[]> {
    const unique = [...new Set(ids)];
    const records = await this.files.getMany(unique, uid);
    if (records.length !== unique.length)
      throw new BadRequestException('Không tìm thấy tệp đính kèm.');
    const notReady = records.find((r) => r.status !== 'ready');
    if (notReady) {
      throw new BadRequestException(`Tệp ${notReady.name} chưa xử lý xong hoặc bị lỗi.`);
    }
    return Promise.all(records.map((r) => this.load(r)));
  }

  /** Files of earlier messages; gone ones come back as unavailable. */
  async forHistory(uid: string, refs: AttachmentRef[]): Promise<LoadedAttachment[]> {
    const records = new Map(
      (
        await this.files.getMany(
          refs.map((r) => r.id),
          uid,
        )
      ).map((r) => [r.id, r]),
    );
    return Promise.all(
      refs.map((ref) => {
        const r = records.get(ref.id);
        return r?.status === 'ready' ? this.load(r) : Promise.resolve(gone(ref));
      }),
    );
  }

  private async load(r: FileRecord): Promise<LoadedAttachment> {
    const ref: AttachmentRef = { id: r.id, name: r.name, kind: r.kind };
    if (!r.storagePath) return gone(ref);
    try {
      const data = await this.blobs.read(r.storagePath);
      return r.kind === 'image'
        ? {
            ref,
            text: null,
            truncated: false,
            image: { mime: r.mime, data: data.toString('base64') },
            available: true,
          }
        : {
            ref,
            text: data.toString('utf8'),
            truncated: r.truncated,
            image: null,
            available: true,
          };
    } catch (err) {
      this.logger.warn(`Không đọc được tệp ${r.id}: ${String(err)}`);
      return gone(ref);
    }
  }
}

const gone = (ref: AttachmentRef): LoadedAttachment => ({
  ref,
  text: null,
  truncated: false,
  image: null,
  available: false,
});
