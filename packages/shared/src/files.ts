import { z } from 'zod';

/**
 * Chat attachments (spec 8.3, 9: files/{id}). The browser uploads straight to Cloud Storage
 * with a signed URL issued by POST /api/files; POST /api/files/:id/complete then checks the
 * file and extracts its text. Only the owner can use a file.
 */

export const FILE_KINDS = ['pdf', 'docx', 'xlsx', 'pptx', 'text', 'image'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const FILE_KIND_LABELS_VI: Record<FileKind, string> = {
  pdf: 'PDF',
  docx: 'Word',
  xlsx: 'Excel',
  pptx: 'PowerPoint',
  text: 'Văn bản',
  image: 'Ảnh',
};

/** Accepted types: MIME type → kind, with the file extensions that go with it. */
export const ACCEPTED_FILE_TYPES: Record<string, { kind: FileKind; extensions: string[] }> = {
  'application/pdf': { kind: 'pdf', extensions: ['pdf'] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    kind: 'docx',
    extensions: ['docx'],
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    kind: 'xlsx',
    extensions: ['xlsx'],
  },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    kind: 'pptx',
    extensions: ['pptx'],
  },
  'text/plain': { kind: 'text', extensions: ['txt'] },
  'text/markdown': { kind: 'text', extensions: ['md', 'markdown'] },
  'text/csv': { kind: 'text', extensions: ['csv'] },
  'image/png': { kind: 'image', extensions: ['png'] },
  'image/jpeg': { kind: 'image', extensions: ['jpg', 'jpeg'] },
  'image/webp': { kind: 'image', extensions: ['webp'] },
  'image/gif': { kind: 'image', extensions: ['gif'] },
};

/** For <input accept>. */
export const FILE_ACCEPT = Object.entries(ACCEPTED_FILE_TYPES)
  .flatMap(([mime, t]) => [mime, ...t.extensions.map((e) => `.${e}`)])
  .join(',');

/**
 * The kind of an upload and its normalized MIME type, decided by the extension (browsers
 * often send "" or application/octet-stream for .md/.csv). A declared MIME type of another
 * accepted kind is refused. Null when the type is not accepted. The API also checks the
 * file's first bytes after upload.
 */
export function fileTypeOf(name: string, mime: string): { kind: FileKind; mime: string } | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const byExt = Object.entries(ACCEPTED_FILE_TYPES).find(([, t]) => t.extensions.includes(ext));
  if (!byExt) return null;
  const declared = ACCEPTED_FILE_TYPES[mime.toLowerCase().split(';')[0]!.trim()];
  if (declared && declared.kind !== byExt[1].kind) return null;
  return { kind: byExt[1].kind, mime: byExt[0] };
}

/** Defaults; the API reads FILE_MAX_MB / FILE_MAX_PAGES (spec 8.3: configurable). */
export const DEFAULT_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_FILE_MAX_PAGES = 200;
/** Providers accept about 5 MB per inline image (Anthropic's limit is the smallest). */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 5;
/** Extracted text kept per file; longer documents are cut (and flagged as truncated). */
export const MAX_EXTRACTED_CHARS = 1_000_000;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

export const fileIdSchema = z.string().regex(/^[A-Za-z0-9]{1,64}$/, 'Mã tệp không hợp lệ');

export const createFileRequestSchema = z
  .object({
    name: z.string().trim().min(1, 'Tên tệp không được trống').max(200, 'Tên tệp quá dài'),
    mime: z.string().max(200),
    size: z.number().int().min(1, 'Tệp rỗng'),
  })
  .strict();
export type CreateFileRequest = z.infer<typeof createFileRequestSchema>;

export const FILE_STATUSES = ['pending', 'ready', 'failed'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

export const fileViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  kind: z.enum(FILE_KINDS),
  size: z.number().int(),
  status: z.enum(FILE_STATUSES),
  /** Pages (PDF), slides (PowerPoint) or sheets (Excel); null for other kinds. */
  pages: z.number().int().nullable(),
  /** Characters of extracted text; null for images. */
  chars: z.number().int().nullable(),
  truncated: z.boolean(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
export type FileView = z.infer<typeof fileViewSchema>;

export const uploadTargetSchema = z.object({
  /** Absolute signed URL, or an API path (starting with "/") in local development. */
  url: z.string(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  /** True when the API path needs the user's ID token (local development only). */
  withAuth: z.boolean(),
});
export type UploadTarget = z.infer<typeof uploadTargetSchema>;

export const createFileResponseSchema = z.object({
  file: fileViewSchema,
  upload: uploadTargetSchema,
});
export type CreateFileResponse = z.infer<typeof createFileResponseSchema>;

/** What a chat message keeps about its attachments. */
export const attachmentRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(FILE_KINDS),
});
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
