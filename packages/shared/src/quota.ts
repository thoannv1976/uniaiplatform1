import { z } from 'zod';
import { QUOTA_TIER_IDS, type QuotaTierId } from './directory.js';
import type { ModelTier } from './models.js';
import { usdToMicro } from './money.js';

/**
 * Quotas, budgets and the cost ledger (spec 8.7). Money is integer micro-USD.
 * Periods are calendar months in Vietnam time (UTC+7), written "YYYYMM".
 */

const VN_OFFSET_MS = 7 * 3600_000;

/** "202610" for any instant of October 2026 in Vietnam time. */
export function quotaPeriodOf(at: Date): string {
  const vn = new Date(at.getTime() + VN_OFFSET_MS);
  return `${vn.getUTCFullYear()}${String(vn.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** UTC instant when a period ends (midnight of the 1st of the next month, Vietnam time). */
export function periodEnd(period: string): Date {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(4, 6));
  return new Date(Date.UTC(year, month, 1) - VN_OFFSET_MS);
}

export const quotaPeriodSchema = z
  .string()
  .regex(/^\d{4}(0[1-9]|1[0-2])$/, 'Kỳ phải có dạng YYYYMM');

/** Models of these tiers also count against the premium budget (spec 8.7, 17). */
export const PREMIUM_MODEL_TIERS: readonly ModelTier[] = ['advanced', 'premium'];
export const isPremiumTier = (tier: ModelTier) => PREMIUM_MODEL_TIERS.includes(tier);

export const quotaTierSchema = z.object({
  id: z.enum(QUOTA_TIER_IDS),
  name: z.string(),
  monthlyBudget: z.number().int().min(0),
  premiumBudget: z.number().int().min(0),
  /** Requests per minute per user (abuse protection). */
  requestsPerMinute: z.number().int().min(1).max(1000),
});
export type QuotaTier = z.infer<typeof quotaTierSchema>;

/** Starting values (spec 17); Super Admin can change them (quotaTiers/{id}). */
export const DEFAULT_QUOTA_TIERS: Record<QuotaTierId, QuotaTier> = {
  standard: {
    id: 'standard',
    name: 'Tiêu chuẩn',
    monthlyBudget: usdToMicro(2),
    premiumBudget: usdToMicro(0.5),
    requestsPerMinute: 10,
  },
  power: {
    id: 'power',
    name: 'Sử dụng nhiều',
    monthlyBudget: usdToMicro(5),
    premiumBudget: usdToMicro(1),
    requestsPerMinute: 20,
  },
  research: {
    id: 'research',
    name: 'Nghiên cứu',
    monthlyBudget: usdToMicro(20),
    premiumBudget: usdToMicro(5),
    requestsPerMinute: 30,
  },
};

export const updateQuotaTierRequestSchema = z
  .object({
    monthlyBudget: z.number().int().min(0).max(1_000_000_000).optional(),
    premiumBudget: z.number().int().min(0).max(1_000_000_000).optional(),
    requestsPerMinute: z.number().int().min(1).max(1000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Cần ít nhất một trường để cập nhật' })
  .refine(
    (v) =>
      v.premiumBudget === undefined ||
      v.monthlyBudget === undefined ||
      v.premiumBudget <= v.monthlyBudget,
    {
      message: 'Hạn mức cao cấp không được lớn hơn ngân sách tháng',
    },
  );
export type UpdateQuotaTierRequest = z.infer<typeof updateQuotaTierRequestSchema>;

/** quotaPeriods/{uid}_{YYYYMM}: the only document written on every AI request. */
export const quotaPeriodDocSchema = z.object({
  uid: z.string(),
  period: z.string(),
  tierId: z.enum(QUOTA_TIER_IDS),
  limit: z.number().int(),
  premiumLimit: z.number().int(),
  used: z.number().int(),
  premiumUsed: z.number().int(),
  reserved: z.number().int(),
  premiumReserved: z.number().int(),
  departmentId: z.string().nullable(),
  departmentPath: z.array(z.string()),
});
export type QuotaPeriodDoc = z.infer<typeof quotaPeriodDocSchema>;

/** GET /api/me/quota and admin views. */
export const quotaSummarySchema = quotaPeriodDocSchema.extend({
  email: z.string().nullable(),
  name: z.string().nullable(),
  remaining: z.number().int(),
  premiumRemaining: z.number().int(),
  /** 0–100, of the monthly limit. */
  percentUsed: z.number(),
});
export type QuotaSummary = z.infer<typeof quotaSummarySchema>;
export const quotaListResponseSchema = z.object({
  period: z.string(),
  quotas: z.array(quotaSummarySchema),
});

export const ADJUSTMENT_TYPES = ['increase', 'decrease', 'set'] as const;
export type AdjustmentType = (typeof ADJUSTMENT_TYPES)[number];
export const ADJUSTMENT_TYPE_LABELS_VI: Record<AdjustmentType, string> = {
  increase: 'Tăng',
  decrease: 'Giảm',
  set: 'Đặt lại',
};

/** Which limit an adjustment changes: the monthly budget or the premium-model budget. */
export const QUOTA_KINDS = ['monthly', 'premium'] as const;
export type QuotaKind = (typeof QUOTA_KINDS)[number];

/** POST /api/admin/quota-adjustments – always with a reason and an approver (spec 8.7). */
export const quotaAdjustmentRequestSchema = z
  .object({
    uid: z.string().min(1).max(128),
    type: z.enum(ADJUSTMENT_TYPES),
    kind: z.enum(QUOTA_KINDS).default('monthly'),
    /** micro-USD; for "set" the new limit. */
    amount: z.number().int().min(0).max(1_000_000_000),
    reason: z.string().trim().min(5, 'Lý do tối thiểu 5 ký tự').max(500),
    approvedBy: z.string().trim().min(2, 'Cần ghi người phê duyệt').max(200),
    /** Temporary grant (increase only): reverted automatically at this time. */
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((v) => !v.expiresAt || v.type === 'increase', {
    message: 'Chỉ cấp tạm thời được đặt ngày hết hạn',
    path: ['expiresAt'],
  });
export type QuotaAdjustmentRequest = z.infer<typeof quotaAdjustmentRequestSchema>;

export const quotaAdjustmentSchema = z.object({
  id: z.string(),
  uid: z.string(),
  period: z.string(),
  type: z.enum(ADJUSTMENT_TYPES),
  kind: z.enum(QUOTA_KINDS),
  amount: z.number().int(),
  /** Limit change actually applied (negative for decreases). */
  delta: z.number().int(),
  reason: z.string(),
  approvedBy: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  revertedAt: z.string().nullable(),
});
export type QuotaAdjustment = z.infer<typeof quotaAdjustmentSchema>;
export const quotaAdjustmentListResponseSchema = z.object({
  adjustments: z.array(quotaAdjustmentSchema),
});

/** budgetPeriods/{deptId}_{YYYYMM}: what a unit may hand out to its people this month. */
export const budgetSchema = z.object({
  departmentId: z.string(),
  period: z.string(),
  budget: z.number().int(),
  /** Σ monthly limits of the unit's staff (live, computed). */
  allocated: z.number().int(),
  /** Σ ledger cost of the unit, updated by the 5-minute aggregation job (M8). */
  usedAggregate: z.number().int(),
  aggregatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type Budget = z.infer<typeof budgetSchema>;
export const budgetListResponseSchema = z.object({
  period: z.string(),
  budgets: z.array(budgetSchema),
});

export const setBudgetRequestSchema = z
  .object({
    budget: z.number().int().min(0).max(100_000_000_000),
    reason: z.string().trim().min(5, 'Lý do tối thiểu 5 ký tự').max(500),
    period: quotaPeriodSchema.optional(),
  })
  .strict();
export type SetBudgetRequest = z.infer<typeof setBudgetRequestSchema>;
