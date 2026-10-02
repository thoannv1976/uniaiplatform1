import { z } from 'zod';
import { MODEL_TIER_LABELS_VI, type ModelTier } from './models.js';

/**
 * Smart Router (spec 8.6): AUTO requests are classified by configurable rules into a model
 * tier, with a reason shown to the user and stored in the ledger. Rules live in
 * settings/router; the first enabled rule (highest priority) whose conditions all hold wins.
 */

/** Tiers AUTO may choose (premium only on explicit choice). */
export const AUTO_ROUTER_TIERS = ['economy', 'standard', 'advanced'] as const;
export type AutoTier = (typeof AUTO_ROUTER_TIERS)[number];

export const routingRuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/, 'Mã luật: chữ thường, số, gạch ngang'),
  name: z.string().trim().min(1, 'Tên luật không được trống').max(100),
  enabled: z.boolean(),
  /** Higher runs first. */
  priority: z.number().int().min(0).max(1000),
  tier: z.enum(AUTO_ROUTER_TIERS),
  /** Any of these words/phrases (case and diacritics ignored); empty = no keyword condition. */
  keywords: z.array(z.string().trim().min(1).max(80)).max(200),
  /** Length of the question plus attached text, in characters. */
  minChars: z.number().int().min(0).max(10_000_000).nullable(),
  maxChars: z.number().int().min(0).max(10_000_000).nullable(),
  /** null = either. */
  hasFiles: z.boolean().nullable(),
  hasImages: z.boolean().nullable(),
});
export type RoutingRule = z.infer<typeof routingRuleSchema>;

export const routerTargetsSchema = z
  .object({
    economy: z.number().int().min(0).max(100),
    standard: z.number().int().min(0).max(100),
    advanced: z.number().int().min(0).max(100),
  })
  .refine((t) => t.economy + t.standard + t.advanced === 100, {
    message: 'Tổng tỷ lệ mục tiêu phải bằng 100%',
  });
export type RouterTargets = z.infer<typeof routerTargetsSchema>;

export const routerConfigSchema = z
  .object({
    rules: z.array(routingRuleSchema).max(100),
    defaultTier: z.enum(AUTO_ROUTER_TIERS),
    /** Target share of requests per tier this month (spec 8.6). */
    targets: routerTargetsSchema,
    /**
     * Above target: when the Advanced share this month exceeds its target by more than
     * 5 points (after 100 requests), AUTO sends Advanced-classified requests to Standard.
     */
    enforceTargets: z.boolean(),
  })
  .strict()
  .refine((c) => new Set(c.rules.map((r) => r.id)).size === c.rules.length, {
    message: 'Mã luật bị trùng',
    path: ['rules'],
  });
export type RouterConfig = z.infer<typeof routerConfigSchema>;

const rule = (
  id: string,
  name: string,
  tier: AutoTier,
  priority: number,
  over: Partial<RoutingRule> = {},
): RoutingRule => ({
  id,
  name,
  enabled: true,
  priority,
  tier,
  keywords: [],
  minChars: null,
  maxChars: null,
  hasFiles: null,
  hasImages: null,
  ...over,
});

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  defaultTier: 'economy',
  targets: { economy: 70, standard: 25, advanced: 5 },
  enforceTargets: true,
  rules: [
    rule('nghien-cuu-chuyen-sau', 'Nghiên cứu, phân tích chuyên sâu', 'advanced', 100, {
      keywords: [
        'phân tích chuyên sâu',
        'nghiên cứu khoa học',
        'đánh giá toàn diện',
        'phản biện',
        'lập luận chặt chẽ',
        'chứng minh',
        'thiết kế nghiên cứu',
        'phương pháp nghiên cứu',
        'mô hình hồi quy',
        'kinh tế lượng',
        'luận án',
        'luận văn',
        'bài báo khoa học',
        'tổng quan tài liệu',
        'literature review',
        'giả thuyết nghiên cứu',
        'chiến lược dài hạn',
        'đề xuất chính sách',
      ],
    }),
    rule('lap-trinh', 'Lập trình, dữ liệu', 'standard', 80, {
      keywords: [
        'code',
        'lập trình',
        'python',
        'sql',
        'javascript',
        'java',
        'debug',
        'lỗi chương trình',
        'thuật toán',
        'công thức excel',
        'hàm excel',
        'vba',
        'regex',
        'api',
        'dữ liệu bảng',
        'pivot',
      ],
    }),
    rule('soan-thao', 'Soạn thảo văn bản dài', 'standard', 70, {
      keywords: [
        'báo cáo',
        'đề cương',
        'tờ trình',
        'kế hoạch',
        'giáo án',
        'bài giảng',
        'đề thi',
        'trắc nghiệm',
        'đề án',
        'công văn',
        'quy chế',
        'hướng dẫn chi tiết',
        'thuyết minh',
      ],
    }),
    rule('tep-dinh-kem', 'Có tệp đính kèm', 'standard', 60, { hasFiles: true }),
    rule('anh', 'Có ảnh', 'standard', 55, { hasImages: true }),
    rule('cau-hoi-dai', 'Câu hỏi dài', 'standard', 50, { minChars: 1500 }),
  ],
};

/** Lower case, no diacritics, single spaces – for keyword matching. */
export function foldText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Keywords match whole words/phrases, so "api" does not match "rapid". */
function containsPhrase(folded: string, keyword: string): boolean {
  const k = foldText(keyword).trim();
  if (!k) return false;
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(folded);
}

export interface RouteInput {
  text: string;
  /** Attached documents (not images). */
  documentCount: number;
  imageCount: number;
  /** Characters of attached document text. */
  attachedChars: number;
}

export interface RouteDecision {
  tier: AutoTier;
  ruleId: string | null;
  reason: string;
}

export function ruleMatches(r: RoutingRule, input: RouteInput, folded = foldText(input.text)) {
  const chars = input.text.length + input.attachedChars;
  if (r.minChars !== null && chars < r.minChars) return false;
  if (r.maxChars !== null && chars > r.maxChars) return false;
  if (r.hasFiles !== null && input.documentCount > 0 !== r.hasFiles) return false;
  if (r.hasImages !== null && input.imageCount > 0 !== r.hasImages) return false;
  if (r.keywords.length > 0 && !r.keywords.some((k) => containsPhrase(folded, k))) return false;
  return true;
}

/** Picks the tier for an AUTO request. */
export function classifyRequest(config: RouterConfig, input: RouteInput): RouteDecision {
  const folded = foldText(input.text);
  const rules = config.rules
    .filter((r) => r.enabled)
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const r of rules) {
    if (ruleMatches(r, input, folded)) {
      return {
        tier: r.tier,
        ruleId: r.id,
        reason: `AUTO: luật "${r.name}" → nhóm ${MODEL_TIER_LABELS_VI[r.tier as ModelTier]}`,
      };
    }
  }
  return {
    tier: config.defaultTier,
    ruleId: null,
    reason: `AUTO: câu hỏi thông thường → nhóm ${MODEL_TIER_LABELS_VI[config.defaultTier]}`,
  };
}

/** AUTO tiers to try, nearest to the wanted one first; ties go to the cheaper tier. */
export function tierFallbackOrder(wanted: AutoTier): AutoTier[] {
  const i = AUTO_ROUTER_TIERS.indexOf(wanted);
  return [...AUTO_ROUTER_TIERS].sort(
    (a, b) =>
      Math.abs(AUTO_ROUTER_TIERS.indexOf(a) - i) - Math.abs(AUTO_ROUTER_TIERS.indexOf(b) - i) ||
      AUTO_ROUTER_TIERS.indexOf(a) - AUTO_ROUTER_TIERS.indexOf(b),
  );
}

export const routerTestRequestSchema = z
  .object({
    text: z.string().max(100_000),
    documentCount: z.number().int().min(0).max(5).default(0),
    imageCount: z.number().int().min(0).max(5).default(0),
    attachedChars: z.number().int().min(0).max(10_000_000).default(0),
  })
  .strict();

export const routerTestResponseSchema = z.object({
  tier: z.enum(AUTO_ROUTER_TIERS),
  ruleId: z.string().nullable(),
  reason: z.string(),
  modelId: z.string().nullable(),
  modelName: z.string().nullable(),
});
export type RouterTestResponse = z.infer<typeof routerTestResponseSchema>;

/** GET /api/admin/router: the configuration and this month's actual share per tier. */
export const routerViewSchema = z.object({
  config: routerConfigSchema,
  period: z.string(),
  requests: z.number().int(),
  /** % of AUTO and chosen requests per tier this month (from the 5-minute aggregates). */
  actual: z.object({
    economy: z.number(),
    standard: z.number(),
    advanced: z.number(),
    premium: z.number(),
  }),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type RouterView = z.infer<typeof routerViewSchema>;
