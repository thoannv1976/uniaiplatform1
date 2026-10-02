import { z } from 'zod';

/**
 * Model Registry (spec 8.5, ADR 0002): providers, models and their price history.
 * All prices are integer micro-USD per 1M tokens (see money.ts).
 */

export const PROVIDER_IDS = ['openai', 'gemini', 'anthropic', 'mock'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_LABELS_VI: Record<ProviderId, string> = {
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  anthropic: 'Anthropic Claude',
  mock: 'Mock (thử nghiệm)',
};

/** direct = vendor API with a key from Secret Manager; vertex = Vertex AI with the service account. */
export const TRANSPORTS = ['direct', 'vertex'] as const;
export type Transport = (typeof TRANSPORTS)[number];

export const TRANSPORT_LABELS_VI: Record<Transport, string> = {
  direct: 'Gọi trực tiếp (API key)',
  vertex: 'Qua Vertex AI (không cần key)',
};

/** Transports each provider supports; the first one is the default. */
export const PROVIDER_TRANSPORTS: Record<ProviderId, readonly Transport[]> = {
  openai: ['direct'],
  gemini: ['vertex', 'direct'],
  anthropic: ['vertex', 'direct'],
  mock: ['direct'],
};

/** Whether calls through this transport need an admin-entered API key. */
export function needsApiKey(provider: ProviderId, transport: Transport): boolean {
  return provider !== 'mock' && transport === 'direct';
}

export const MODEL_TIERS = ['economy', 'standard', 'advanced', 'premium'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const MODEL_TIER_LABELS_VI: Record<ModelTier, string> = {
  economy: 'Tiết kiệm',
  standard: 'Tiêu chuẩn',
  advanced: 'Nâng cao',
  premium: 'Cao cấp',
};

export const MODEL_STATUSES = ['active', 'disabled'] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

export const MODEL_STATUS_LABELS_VI: Record<ModelStatus, string> = {
  active: 'Đang bật',
  disabled: 'Đang tắt',
};

export const MODEL_CAPABILITIES = ['text', 'image', 'pdf', 'tools'] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export const MODEL_CAPABILITY_LABELS_VI: Record<ModelCapability, string> = {
  text: 'Văn bản',
  image: 'Ảnh',
  pdf: 'PDF',
  tools: 'Công cụ',
};

/** Reasoning depth passed to models that support it; omitted = provider default. */
export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const providerIdSchema = z.enum(PROVIDER_IDS);

// ---------------------------------------------------------------------------
// Providers

export const providerKeyInfoSchema = z.object({
  configured: z.boolean(),
  /** Last 4 characters of the key, for display as "…abcd". Never the key itself. */
  last4: z.string().nullable(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export type ProviderKeyInfo = z.infer<typeof providerKeyInfoSchema>;

export const providerSettingsSchema = z.object({
  id: providerIdSchema,
  name: z.string(),
  transport: z.enum(TRANSPORTS),
  enabled: z.boolean(),
  /** Lower = tried first when falling back between providers of the same tier (M8). */
  fallbackOrder: z.number().int(),
  key: providerKeyInfoSchema,
});
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;

export const providerViewSchema = providerSettingsSchema.extend({
  transports: z.array(z.enum(TRANSPORTS)),
  /** The current transport needs a key. */
  keyRequired: z.boolean(),
  /** Enabled and, if a key is required, one has been entered. */
  ready: z.boolean(),
});
export type ProviderView = z.infer<typeof providerViewSchema>;
export const providerListResponseSchema = z.object({ providers: z.array(providerViewSchema) });

export const updateProviderRequestSchema = z
  .object({
    transport: z.enum(TRANSPORTS).optional(),
    enabled: z.boolean().optional(),
    fallbackOrder: z.number().int().min(0).max(99).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Cần ít nhất một trường để cập nhật' });
export type UpdateProviderRequest = z.infer<typeof updateProviderRequestSchema>;

/** PUT /api/admin/providers/:id/key – write-only; the key is never returned or logged. */
export const setProviderKeyRequestSchema = z
  .object({
    apiKey: z
      .string()
      .trim()
      .min(20, 'API key quá ngắn')
      .max(512, 'API key quá dài')
      .regex(/^[\x21-\x7e]+$/, 'API key không được chứa khoảng trắng hay ký tự đặc biệt'),
  })
  .strict();
export type SetProviderKeyRequest = z.infer<typeof setProviderKeyRequestSchema>;

/** "…abcd" – how a stored key is shown. */
export function maskedKey(last4: string | null): string {
  return last4 ? `…${last4}` : '';
}

// ---------------------------------------------------------------------------
// Models and prices

/** Registry ids double as Firestore document ids. */
export const modelIdSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,62}$/,
    'Mã model chỉ gồm chữ thường, số, ".", "_" hoặc "-" (tối đa 63 ký tự)',
  );

/** Id as the provider expects it, e.g. "claude-haiku-4-5@20251001" on Vertex AI. */
export const apiModelIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/, 'Mã model của nhà cung cấp không hợp lệ');

/** Integer micro-USD per 1M tokens; at most $10,000 per 1M tokens. */
export const microPerMTokSchema = z.number().int().min(0).max(10_000_000_000);

export const modelDefaultParamsSchema = z
  .object({ reasoningEffort: z.enum(REASONING_EFFORTS).optional() })
  .strict();
export type ModelDefaultParams = z.infer<typeof modelDefaultParamsSchema>;

const modelFields = {
  providerId: providerIdSchema,
  apiModelId: apiModelIdSchema,
  displayName: z.string().trim().min(1, 'Tên hiển thị không được trống').max(100),
  tier: z.enum(MODEL_TIERS),
  status: z.enum(MODEL_STATUSES),
  contextWindow: z.number().int().min(1).max(100_000_000),
  maxOutputTokens: z.number().int().min(1).max(10_000_000),
  capabilities: z
    .array(z.enum(MODEL_CAPABILITIES))
    .min(1)
    .transform((list) => [...new Set(list)]),
  /** Higher = preferred among models of the same tier (router, M6). */
  priority: z.number().int().min(0).max(1000),
  /** Optional per-user requests per minute for this model; null = no extra limit. */
  rateLimitPerMinute: z.number().int().min(1).max(100_000).nullable(),
  defaultParams: modelDefaultParamsSchema,
  notes: z.string().trim().max(500),
};

export const priceSchema = z.object({
  id: z.string(),
  inputPerMTok: microPerMTokSchema,
  outputPerMTok: microPerMTokSchema,
  /** Price of cached input tokens; null = billed at the input price. */
  cachedInputPerMTok: microPerMTokSchema.nullable(),
  effectiveFrom: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
});
export type Price = z.infer<typeof priceSchema>;

export const modelSchema = z.object({
  id: z.string(),
  ...modelFields,
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export type Model = z.infer<typeof modelSchema>;

export const modelViewSchema = modelSchema.extend({
  /** Price in effect now; null when no price applies yet (the model cannot be used). */
  currentPrice: priceSchema.nullable(),
  /** A price that takes effect later, if one was scheduled. */
  nextPrice: priceSchema.nullable(),
});
export type ModelView = z.infer<typeof modelViewSchema>;
export const modelListResponseSchema = z.object({ models: z.array(modelViewSchema) });
export const priceListResponseSchema = z.object({ prices: z.array(priceSchema) });

export const newPriceSchema = z
  .object({
    inputPerMTok: microPerMTokSchema,
    outputPerMTok: microPerMTokSchema,
    cachedInputPerMTok: microPerMTokSchema.nullable().default(null),
    /** ISO time; omitted = now. Past times are refused so settled costs keep their price. */
    effectiveFrom: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export type NewPrice = z.infer<typeof newPriceSchema>;

export const createModelRequestSchema = z
  .object({
    id: modelIdSchema,
    ...modelFields,
    status: modelFields.status.default('disabled'),
    rateLimitPerMinute: modelFields.rateLimitPerMinute.default(null),
    defaultParams: modelFields.defaultParams.default({}),
    notes: modelFields.notes.default(''),
    priority: modelFields.priority.default(100),
    price: newPriceSchema.omit({ effectiveFrom: true }),
  })
  .strict();
export type CreateModelRequest = z.infer<typeof createModelRequestSchema>;

export const updateModelRequestSchema = z
  .object({
    apiModelId: modelFields.apiModelId,
    displayName: modelFields.displayName,
    tier: modelFields.tier,
    status: modelFields.status,
    contextWindow: modelFields.contextWindow,
    maxOutputTokens: modelFields.maxOutputTokens,
    capabilities: modelFields.capabilities,
    priority: modelFields.priority,
    rateLimitPerMinute: modelFields.rateLimitPerMinute,
    defaultParams: modelFields.defaultParams,
    notes: modelFields.notes,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Cần ít nhất một trường để cập nhật' });
export type UpdateModelRequest = z.infer<typeof updateModelRequestSchema>;

/** POST /api/admin/models/:id/test – one short real call to check id, access and price. */
export const testModelRequestSchema = z
  .object({ prompt: z.string().trim().min(1).max(500).optional() })
  .strict();
export type TestModelRequest = z.infer<typeof testModelRequestSchema>;

export const DEFAULT_TEST_PROMPT = 'Xin chào! Hãy trả lời bằng đúng một câu ngắn tiếng Việt.';

export const testModelResponseSchema = z.object({
  ok: z.boolean(),
  modelId: z.string(),
  apiModelId: z.string(),
  transport: z.enum(TRANSPORTS),
  text: z.string(),
  stopReason: z.string().nullable(),
  usage: z
    .object({
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
      cachedInputTokens: z.number().int(),
    })
    .nullable(),
  /** micro-USD at the current price; null if the call failed or no price applies. */
  cost: z.number().int().nullable(),
  latencyMs: z.number().int(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type TestModelResponse = z.infer<typeof testModelResponseSchema>;

export const seedModelsResponseSchema = z.object({ created: z.array(z.string()) });

/** Picks the price in effect at `at` from a model's price history. */
export function priceAt<P extends { effectiveFrom: string }>(prices: P[], at: Date): P | null {
  let best: P | null = null;
  for (const p of prices) {
    if (Date.parse(p.effectiveFrom) > at.getTime()) continue;
    if (!best || Date.parse(p.effectiveFrom) > Date.parse(best.effectiveFrom)) best = p;
  }
  return best;
}

/** The earliest price that starts after `at`, if any. */
export function nextPriceAfter<P extends { effectiveFrom: string }>(
  prices: P[],
  at: Date,
): P | null {
  let best: P | null = null;
  for (const p of prices) {
    if (Date.parse(p.effectiveFrom) <= at.getTime()) continue;
    if (!best || Date.parse(p.effectiveFrom) < Date.parse(best.effectiveFrom)) best = p;
  }
  return best;
}
