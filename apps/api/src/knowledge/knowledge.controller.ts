import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Patch,
  PayloadTooLargeException,
  Post,
  Put,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  KnowledgeError,
  toKbDocumentView,
  type BlobStore,
  type DepartmentStore,
  type KnowledgeStore,
} from '@uniai/firestore';
import {
  createKbDocumentRequestSchema,
  createKnowledgeBaseRequestSchema,
  fileTypeOf,
  formatBytes,
  KB_MAX_BYTES,
  knowledgeBaseIdSchema,
  updateKnowledgeBaseRequestSchema,
  type CreateKbDocumentResponse,
  type KbDocument,
  type KnowledgeBase,
} from '@uniai/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { Roles } from '../auth/decorators.js';
import { parseOrBadRequest } from '../common/zod.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DEPARTMENT_STORE } from '../departments/departments.controller.js';
import { BLOB_STORE } from '../files/files.service.js';
import { INGEST_QUEUE, KNOWLEDGE_STORE, type IngestQueue } from './tokens.js';

const UPLOAD_URL_TTL_MS = 15 * 60_000;

function idOr404(raw: string): string {
  const parsed = knowledgeBaseIdSchema.safeParse(raw);
  if (!parsed.success) throw new NotFoundException('Không tìm thấy.');
  return parsed.data;
}

function mapError(err: unknown): never {
  if (err instanceof KnowledgeError) {
    if (err.code === 'not_found') throw new NotFoundException(err.message);
    if (err.code === 'conflict') throw new ConflictException(err.message);
    throw new BadRequestException(err.message);
  }
  throw err;
}

/**
 * Knowledge Base administration (spec 8.9): AI Admin and Super Admin load documents;
 * Auditor reads. Upload goes straight to Cloud Storage with a signed URL.
 */
@Controller('api/admin')
export class KnowledgeController {
  private readonly logger = new Logger('Knowledge');

  constructor(
    @Inject(KNOWLEDGE_STORE) private readonly store: KnowledgeStore,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore,
    @Inject(INGEST_QUEUE) private readonly queue: IngestQueue,
    @Inject(DEPARTMENT_STORE) private readonly departments: DepartmentStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  private async checkScope(aclScopeId: string | null | undefined) {
    if (!aclScopeId) return;
    if (!(await this.departments.map()).has(aclScopeId)) {
      throw new BadRequestException('Đơn vị phạm vi không tồn tại.');
    }
  }

  private record(actor: string, target: string, metadata: Record<string, unknown>) {
    return this.audit.record({ event: 'KNOWLEDGE_UPDATE', actor, target, metadata });
  }

  @Get('knowledge-bases')
  @Roles('super_admin', 'ai_admin', 'auditor')
  async list(): Promise<{ knowledgeBases: KnowledgeBase[] }> {
    return { knowledgeBases: await this.store.listKbs() };
  }

  @Post('knowledge-bases')
  @Roles('super_admin', 'ai_admin')
  async create(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<KnowledgeBase> {
    const input = parseOrBadRequest(createKnowledgeBaseRequestSchema, body);
    await this.checkScope(input.aclScopeId);
    const kb = await this.store.createKb(input, auth.profile.uid);
    await this.record(auth.profile.uid, `knowledgeBases/${kb.id}`, {
      action: 'create_kb',
      aclScopeId: kb.aclScopeId,
    });
    return kb;
  }

  @Patch('knowledge-bases/:id')
  @Roles('super_admin', 'ai_admin')
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<KnowledgeBase> {
    const patch = parseOrBadRequest(updateKnowledgeBaseRequestSchema, body);
    await this.checkScope(patch.aclScopeId);
    const kb = await this.store.updateKb(idOr404(id), patch).catch(mapError);
    await this.record(auth.profile.uid, `knowledgeBases/${kb.id}`, {
      action: 'update_kb',
      ...patch,
    });
    return kb;
  }

  @Get('knowledge-bases/:id/documents')
  @Roles('super_admin', 'ai_admin', 'auditor')
  async documents(@Param('id') id: string): Promise<{ documents: KbDocument[] }> {
    const kbId = idOr404(id);
    if (!(await this.store.getKb(kbId)))
      throw new NotFoundException('Không tìm thấy kho tri thức.');
    return { documents: await this.store.listDocuments(kbId) };
  }

  /** Registers a document (or a new version) and returns where to PUT the file. */
  @Post('knowledge-bases/:id/documents')
  @Roles('super_admin', 'ai_admin')
  async addDocument(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CreateKbDocumentResponse> {
    const kbId = idOr404(id);
    const input = parseOrBadRequest(createKbDocumentRequestSchema, body);
    if (!(await this.store.getKb(kbId)))
      throw new NotFoundException('Không tìm thấy kho tri thức.');
    const type = fileTypeOf(input.fileName, input.mime);
    if (!type || type.kind === 'image') {
      throw new BadRequestException(
        'Kho tri thức nhận PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx) hoặc văn bản.',
      );
    }
    if (input.size > KB_MAX_BYTES) {
      throw new PayloadTooLargeException(`Tài liệu tối đa ${formatBytes(KB_MAX_BYTES)}.`);
    }
    const doc = await this.store
      .createDocument({
        kbId,
        title: input.title,
        fileName: input.fileName,
        mime: type.mime,
        size: input.size,
        effectiveDate: input.effectiveDate,
        replacesId: input.replacesDocumentId,
        uploadedBy: auth.profile.uid,
      })
      .catch(mapError);
    const upload =
      this.config.fileUploadMode === 'proxy'
        ? {
            url: `/api/admin/kb-documents/${doc.id}/content`,
            method: 'PUT' as const,
            headers: { 'Content-Type': type.mime },
            withAuth: true,
          }
        : {
            ...(await this.blobs.signedUploadUrl(
              doc.sourcePath,
              type.mime,
              input.size,
              UPLOAD_URL_TTL_MS,
            )),
            method: 'PUT' as const,
            withAuth: false,
          };
    return { document: toKbDocumentView(doc), upload };
  }

  /** Local development only (FILE_UPLOAD_MODE=proxy). */
  @Put('kb-documents/:id/content')
  @HttpCode(204)
  @Roles('super_admin', 'ai_admin')
  async content(@Param('id') id: string, @Body() body: unknown): Promise<void> {
    if (this.config.fileUploadMode !== 'proxy') throw new NotFoundException();
    const doc = await this.store.getDocument(idOr404(id));
    if (!doc) throw new NotFoundException('Không tìm thấy tài liệu.');
    if (doc.status !== 'uploading') throw new ConflictException('Tài liệu đã được tải lên.');
    if (!Buffer.isBuffer(body) || body.length === 0) throw new BadRequestException('Tệp rỗng.');
    if (body.length > doc.size)
      throw new PayloadTooLargeException('Tệp lớn hơn kích thước đã khai báo.');
    await this.blobs.write(doc.sourcePath, body, doc.mime);
  }

  /** After the upload: queue the document for extraction, chunking and embedding. */
  @Post('kb-documents/:id/complete')
  @HttpCode(200)
  @Roles('super_admin', 'ai_admin')
  async complete(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<KbDocument> {
    const doc = await this.store.getDocument(idOr404(id));
    if (!doc) throw new NotFoundException('Không tìm thấy tài liệu.');
    if (doc.status === 'uploading') {
      const size = await this.blobs.size(doc.sourcePath);
      if (size === null) throw new ConflictException('Chưa nhận được tệp. Vui lòng tải lên lại.');
      if (size > KB_MAX_BYTES) {
        await this.store.setStatus(doc.id, 'failed', 'Tệp vượt giới hạn dung lượng.');
        throw new UnprocessableEntityException('Tệp vượt giới hạn dung lượng.');
      }
      if (await this.store.claim(doc.id, ['uploading'], 'queued')) {
        await this.record(auth.profile.uid, `documents/${doc.id}`, {
          action: 'upload_document',
          kbId: doc.kbId,
          version: doc.version,
          size,
        });
        await this.dispatch(doc.id);
      }
    }
    return toKbDocumentView((await this.store.getDocument(doc.id))!);
  }

  /** Puts a failed document back in the queue. */
  @Post('kb-documents/:id/retry')
  @HttpCode(200)
  @Roles('super_admin', 'ai_admin')
  async retry(@Param('id') id: string): Promise<KbDocument> {
    const docId = idOr404(id);
    if (!(await this.store.claim(docId, ['failed'], 'queued'))) {
      throw new ConflictException('Chỉ xử lý lại được tài liệu bị lỗi.');
    }
    await this.dispatch(docId);
    return toKbDocumentView((await this.store.getDocument(docId))!);
  }

  private async dispatch(documentId: string) {
    try {
      await this.queue.enqueue(documentId);
    } catch (err) {
      this.logger.error(`Không đưa được tài liệu ${documentId} vào hàng đợi: ${String(err)}`);
      await this.store.setStatus(
        documentId,
        'failed',
        'Không đưa được vào hàng đợi xử lý. Báo quản trị hệ thống kiểm tra Cloud Tasks rồi bấm Xử lý lại.',
      );
    }
  }

  @Delete('kb-documents/:id')
  @HttpCode(204)
  @Roles('super_admin', 'ai_admin')
  async remove(@CurrentAuth() auth: AuthContext, @Param('id') id: string): Promise<void> {
    const doc = await this.store.deleteDocument(idOr404(id));
    if (!doc) throw new NotFoundException('Không tìm thấy tài liệu.');
    await this.blobs.delete(doc.sourcePath).catch(() => undefined);
    await this.record(auth.profile.uid, `documents/${doc.id}`, {
      action: 'delete_document',
      kbId: doc.kbId,
      version: doc.version,
    });
  }
}
