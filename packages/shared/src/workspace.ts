import { z } from 'zod';

/**
 * Personal workspace (spec 8.10, M14): prompt library (private prompts and prompts that
 * AI Admins publish to units), projects (conversations + files + instructions) and files.
 */

/** Variables are written {{ten_bien}} in a prompt body. */
const VARIABLE = /\{\{\s*([\p{L}\p{N}_ ]{1,40}?)\s*\}\}/gu;

export function extractVariables(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(VARIABLE)) seen.add(m[1]!.trim());
  return [...seen];
}

/** Replaces {{name}} with the given values; unknown variables stay as written. */
export function fillPrompt(body: string, values: Record<string, string>): string {
  return body.replace(VARIABLE, (whole, name: string) => {
    const v = values[name.trim()];
    return v === undefined || v === '' ? whole : v;
  });
}

export const PROMPT_VISIBILITIES = ['private', 'shared'] as const;
export type PromptVisibility = (typeof PROMPT_VISIBILITIES)[number];

export const PROMPT_CATEGORIES = [
  'giang-day',
  'nghien-cuu',
  'hanh-chinh',
  'dich-thuat',
  'khac',
] as const;
export type PromptCategory = (typeof PROMPT_CATEGORIES)[number];
export const PROMPT_CATEGORY_LABELS_VI: Record<PromptCategory, string> = {
  'giang-day': 'Giảng dạy',
  'nghien-cuu': 'Nghiên cứu',
  'hanh-chinh': 'Hành chính',
  'dich-thuat': 'Dịch thuật',
  khac: 'Khác',
};

export const promptSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  body: z.string(),
  category: z.enum(PROMPT_CATEGORIES),
  variables: z.array(z.string()),
  visibility: z.enum(PROMPT_VISIBILITIES),
  /** Shared prompts: units that see it (sub-units included); empty = whole university. */
  publishedTo: z.array(z.string()),
  ownerUid: z.string(),
  /** The caller may edit or delete it. */
  editable: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Prompt = z.infer<typeof promptSchema>;

const promptFields = {
  title: z.string().trim().min(1, 'Tiêu đề không được trống').max(120),
  description: z.string().trim().max(500),
  body: z.string().trim().min(1, 'Nội dung không được trống').max(8000),
  category: z.enum(PROMPT_CATEGORIES),
  visibility: z.enum(PROMPT_VISIBILITIES),
  publishedTo: z.array(z.string().min(1).max(64)).max(50),
};

export const createPromptRequestSchema = z
  .object({
    ...promptFields,
    description: promptFields.description.default(''),
    category: promptFields.category.default('khac'),
    visibility: promptFields.visibility.default('private'),
    publishedTo: promptFields.publishedTo.default([]),
  })
  .strict();
export type CreatePromptRequest = z.infer<typeof createPromptRequestSchema>;

export const updatePromptRequestSchema = z
  .object({
    title: promptFields.title.optional(),
    description: promptFields.description.optional(),
    body: promptFields.body.optional(),
    category: promptFields.category.optional(),
    visibility: promptFields.visibility.optional(),
    publishedTo: promptFields.publishedTo.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Cần ít nhất một trường để cập nhật' });
export type UpdatePromptRequest = z.infer<typeof updatePromptRequestSchema>;

export const promptListResponseSchema = z.object({ prompts: z.array(promptSchema) });

export const MAX_PROJECT_FILES = 10;

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Added to the system prompt of every conversation in the project. */
  instructions: z.string(),
  /** Ready files (POST /api/files) given to the model in every conversation. */
  fileIds: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectRequestSchema = z
  .object({
    name: z.string().trim().min(1, 'Tên dự án không được trống').max(100),
    instructions: z.string().trim().max(8000).default(''),
    fileIds: z
      .array(z.string().regex(/^[A-Za-z0-9]{1,64}$/))
      .max(MAX_PROJECT_FILES, `Tối đa ${MAX_PROJECT_FILES} tệp mỗi dự án`)
      .default([]),
  })
  .strict();
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const updateProjectRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    instructions: z.string().trim().max(8000).optional(),
    fileIds: z
      .array(z.string().regex(/^[A-Za-z0-9]{1,64}$/))
      .max(MAX_PROJECT_FILES, `Tối đa ${MAX_PROJECT_FILES} tệp mỗi dự án`)
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Cần ít nhất một trường để cập nhật' });
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

export const projectListResponseSchema = z.object({ projects: z.array(projectSchema) });
