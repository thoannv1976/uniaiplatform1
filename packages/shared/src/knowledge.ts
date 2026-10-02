import { z } from 'zod';
import { uploadTargetSchema } from './files.js';

/**
 * Knowledge Base (spec 8.9): AI Admins load official documents (regulations…) into
 * knowledge bases; a worker extracts, chunks (~800 tokens, 100 overlap) and embeds them
 * (Vertex AI); chat retrieves chunks the user may see (M13).
 */

export const knowledgeBaseIdSchema = z.string().regex(/^[A-Za-z0-9]{1,64}$/, 'Mã kho không hợp lệ');

export const knowledgeBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** Unit whose staff (sub-units included) may use it; null = the whole university. */
  aclScopeId: z.string().nullable(),
  /** Usable in chat. */
  active: z.boolean(),
  documentCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KnowledgeBase = z.infer<typeof knowledgeBaseSchema>;

export const createKnowledgeBaseRequestSchema = z
  .object({
    name: z.string().trim().min(1, 'Tên kho không được trống').max(120),
    description: z.string().trim().max(1000).default(''),
    aclScopeId: z.string().min(1).max(64).nullable(),
  })
  .strict();
export type CreateKnowledgeBaseRequest = z.infer<typeof createKnowledgeBaseRequestSchema>;

export const updateKnowledgeBaseRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).optional(),
    aclScopeId: z.string().min(1).max(64).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Cần ít nhất một trường để cập nhật' });
export type UpdateKnowledgeBaseRequest = z.infer<typeof updateKnowledgeBaseRequestSchema>;

export const KB_DOCUMENT_STATUSES = [
  'uploading',
  'queued',
  'processing',
  'ready',
  'failed',
  'superseded',
] as const;
export type KbDocumentStatus = (typeof KB_DOCUMENT_STATUSES)[number];

export const KB_DOCUMENT_STATUS_LABELS_VI: Record<KbDocumentStatus, string> = {
  uploading: 'Đang tải lên',
  queued: 'Chờ xử lý',
  processing: 'Đang xử lý',
  ready: 'Sẵn sàng',
  failed: 'Lỗi',
  superseded: 'Đã thay bằng phiên bản mới',
};

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày dạng YYYY-MM-DD');

export const kbDocumentSchema = z.object({
  id: z.string(),
  kbId: z.string(),
  title: z.string(),
  /** 1, 2, 3… within the same document (replacesId chain). */
  version: z.number().int(),
  effectiveDate: dateSchema.nullable(),
  status: z.enum(KB_DOCUMENT_STATUSES),
  fileName: z.string(),
  mime: z.string(),
  size: z.number().int(),
  pages: z.number().int().nullable(),
  chunkCount: z.number().int(),
  error: z.string().nullable(),
  /** The earlier version this one replaces. */
  replacesId: z.string().nullable(),
  uploadedBy: z.string(),
  createdAt: z.string(),
  readyAt: z.string().nullable(),
});
export type KbDocument = z.infer<typeof kbDocumentSchema>;

export const createKbDocumentRequestSchema = z
  .object({
    title: z.string().trim().min(1, 'Tiêu đề không được trống').max(300),
    fileName: z.string().trim().min(1).max(200),
    mime: z.string().max(200),
    size: z.number().int().min(1, 'Tệp rỗng'),
    effectiveDate: dateSchema.nullable().default(null),
    replacesDocumentId: z
      .string()
      .regex(/^[A-Za-z0-9]{1,64}$/)
      .nullable()
      .default(null),
  })
  .strict();
export type CreateKbDocumentRequest = z.infer<typeof createKbDocumentRequestSchema>;

export const createKbDocumentResponseSchema = z.object({
  document: kbDocumentSchema,
  upload: uploadTargetSchema,
});
export type CreateKbDocumentResponse = z.infer<typeof createKbDocumentResponseSchema>;

export const knowledgeBaseListResponseSchema = z.object({
  knowledgeBases: z.array(knowledgeBaseSchema),
});
export const kbDocumentListResponseSchema = z.object({ documents: z.array(kbDocumentSchema) });

/** Knowledge-base documents may be up to 50 MB (regulation collections). */
export const KB_MAX_BYTES = 50 * 1024 * 1024;
export const KB_MAX_PAGES = 2_000;

/** A knowledge base a user may consult in chat (GET /api/knowledge-bases). */
export const chatKnowledgeBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  documentCount: z.number().int(),
});
export type ChatKnowledgeBase = z.infer<typeof chatKnowledgeBaseSchema>;
export const chatKnowledgeBaseListResponseSchema = z.object({
  knowledgeBases: z.array(chatKnowledgeBaseSchema),
});
