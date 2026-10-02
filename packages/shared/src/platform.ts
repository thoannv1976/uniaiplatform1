import { z } from 'zod';
import { CHAT_MODEL_AUTO } from './chat.js';
import { modelIdSchema, MODEL_TIERS, PROVIDER_IDS } from './models.js';

/**
 * Platform API (spec 13.3 M17): internal applications (LMS, portals, AI Tutor…) call the AI
 * Gateway with an application key instead of a staff login. Each app belongs to a unit, has
 * its own monthly budget (micro-USD) and rate limit, and is billed in the same ledger.
 */

export const APP_SCOPES = ['chat', 'models', 'usage', 'agents'] as const;
export type AppScope = (typeof APP_SCOPES)[number];
export const APP_SCOPE_LABELS_VI: Record<AppScope, string> = {
  chat: 'Gọi AI (chat)',
  models: 'Xem danh sách model',
  usage: 'Xem mức sử dụng của ứng dụng',
  agents: 'Chạy agent (M18)',
};

export const APP_STATUSES = ['active', 'disabled'] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

/** Application keys: "uak_<clientId>_<secret>"; only a SHA-256 hash is stored. */
export const APP_KEY_PREFIX = 'uak_';
export const APP_KEY_PATTERN = /^uak_([A-Za-z0-9]{20})_([A-Za-z0-9_-]{43})$/;

export const appClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  ownerDepartmentId: z.string(),
  scopes: z.array(z.enum(APP_SCOPES)),
  /** micro-USD per month; 0 = cannot call AI. */
  monthlyBudget: z.number().int(),
  requestsPerMinute: z.number().int(),
  /** May use Advanced/Premium models (otherwise AUTO stays on cheaper tiers). */
  allowAdvanced: z.boolean(),
  status: z.enum(APP_STATUSES),
  /** Last 4 characters of the key, to tell keys apart. */
  keyLast4: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  rotatedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});
export type AppClient = z.infer<typeof appClientSchema>;

/** Admin list: the client plus this month's spend. */
export const appClientViewSchema = appClientSchema.extend({
  period: z.string(),
  used: z.number().int(),
  reserved: z.number().int(),
});
export type AppClientView = z.infer<typeof appClientViewSchema>;
export const appClientListResponseSchema = z.object({ clients: z.array(appClientViewSchema) });

const nameSchema = z.string().trim().min(1, 'Tên ứng dụng không được trống').max(100);
const budgetSchema = z.number().int('Ngân sách là số nguyên micro-USD').min(0).max(100_000_000_000);

export const createAppClientRequestSchema = z
  .object({
    name: nameSchema,
    description: z.string().trim().max(500).default(''),
    ownerDepartmentId: z.string().min(1, 'Chọn đơn vị chủ quản').max(64),
    scopes: z.array(z.enum(APP_SCOPES)).min(1, 'Chọn ít nhất một quyền').max(APP_SCOPES.length),
    monthlyBudget: budgetSchema,
    requestsPerMinute: z.number().int().min(1).max(600).default(60),
    allowAdvanced: z.boolean().default(false),
  })
  .strict();
export type CreateAppClientRequest = z.infer<typeof createAppClientRequestSchema>;

export const updateAppClientRequestSchema = z
  .object({
    name: nameSchema.optional(),
    description: z.string().trim().max(500).optional(),
    scopes: z.array(z.enum(APP_SCOPES)).min(1).max(APP_SCOPES.length).optional(),
    monthlyBudget: budgetSchema.optional(),
    requestsPerMinute: z.number().int().min(1).max(600).optional(),
    allowAdvanced: z.boolean().optional(),
    status: z.enum(APP_STATUSES).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Cần ít nhất một trường để cập nhật' });
export type UpdateAppClientRequest = z.infer<typeof updateAppClientRequestSchema>;

/** Returned once, when a key is created or rotated: the key itself is never stored. */
export const appClientKeyResponseSchema = z.object({
  client: appClientSchema,
  key: z.string(),
});
export type AppClientKeyResponse = z.infer<typeof appClientKeyResponseSchema>;

// ---------------------------------------------------------------------------
// Platform API v1 (Authorization: Bearer uak_…)

export const PLATFORM_MAX_MESSAGES = 50;
export const PLATFORM_MAX_CHARS = 200_000;

export const platformMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().max(PLATFORM_MAX_CHARS),
});
export type PlatformMessage = z.infer<typeof platformMessageSchema>;

export const platformChatRequestSchema = z
  .object({
    /** Conversation so far, oldest first; the last message must be from the user. */
    messages: z
      .array(platformMessageSchema)
      .min(1)
      .max(PLATFORM_MAX_MESSAGES)
      .refine((m) => m.at(-1)?.role === 'user', {
        message: 'Tin nhắn cuối phải là của người dùng (role "user")',
      })
      .refine((m) => m.reduce((n, x) => n + x.content.length, 0) <= PLATFORM_MAX_CHARS, {
        message: `Tổng độ dài tối đa ${PLATFORM_MAX_CHARS.toLocaleString('vi-VN')} ký tự`,
      }),
    /** "auto" (Smart Router) or a registry model id. */
    model: z.union([z.literal(CHAT_MODEL_AUTO), modelIdSchema]).default(CHAT_MODEL_AUTO),
    maxOutputTokens: z.number().int().min(16).max(16_000).optional(),
    /** true = Server-Sent Events (platformStreamEventSchema); false = one JSON response. */
    stream: z.boolean().default(false),
    /** The app confirms sending content the DLP policy warns about (428 otherwise). */
    dlpAcknowledged: z.boolean().optional(),
    /** Free text for the app's own tracing (≤ 64 chars), stored in the ledger. */
    reference: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,64}$/, 'reference: tối đa 64 ký tự chữ, số, . _ : -')
      .optional(),
  })
  .strict();
export type PlatformChatRequest = z.infer<typeof platformChatRequestSchema>;

const usageSchema = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cachedInputTokens: z.number().int(),
});

const modelInfoSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  providerId: z.enum(PROVIDER_IDS),
  tier: z.enum(MODEL_TIERS),
});

export const platformChatResponseSchema = z.object({
  /** Ledger transaction id (quote it when reporting a problem). */
  id: z.string(),
  model: modelInfoSchema,
  routeReason: z.string(),
  output: z.string(),
  stopReason: z.string().nullable(),
  usage: usageSchema.nullable(),
  /** micro-USD charged to the app's budget. */
  cost: z.number().int().nullable(),
  latencyMs: z.number().int(),
});
export type PlatformChatResponse = z.infer<typeof platformChatResponseSchema>;

export const platformStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('meta'),
    id: z.string(),
    model: modelInfoSchema,
    routeReason: z.string(),
  }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({
    type: z.literal('done'),
    id: z.string(),
    stopReason: z.string().nullable(),
    usage: usageSchema.nullable(),
    cost: z.number().int().nullable(),
    latencyMs: z.number().int(),
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type PlatformStreamEvent = z.infer<typeof platformStreamEventSchema>;

export const platformModelsResponseSchema = z.object({
  models: z.array(modelInfoSchema.extend({ capabilities: z.array(z.string()) })),
});
export type PlatformModelsResponse = z.infer<typeof platformModelsResponseSchema>;

export const platformUsageResponseSchema = z.object({
  appId: z.string(),
  period: z.string(),
  monthlyBudget: z.number().int(),
  used: z.number().int(),
  reserved: z.number().int(),
  remaining: z.number().int(),
  requestsPerMinute: z.number().int(),
});
export type PlatformUsageResponse = z.infer<typeof platformUsageResponseSchema>;

/** Ledger uid of an application's requests. */
export const appLedgerUid = (clientId: string) => `app:${clientId}`;
