import { z } from 'zod';
import { microToUsd } from './money.js';
import { quotaSummarySchema } from './quota.js';

/**
 * Usage statistics, dashboards and alerts (spec 8.13). Figures come from the cost ledger,
 * aggregated every 5 minutes into usageAggregates/{YYYYMM}; money is integer micro-USD.
 */

/** Default exchange rate when the admin has not set one (settings/app.exchangeRateVndPerUsd). */
export const DEFAULT_VND_PER_USD = 26_000;

/** "≈ 52.000 ₫" – VND for display only, rounded to whole dong. */
export function formatVnd(micro: number, vndPerUsd: number): string {
  const vnd = Math.round(microToUsd(micro) * vndPerUsd);
  return `${vnd.toLocaleString('vi-VN')} ₫`;
}

/** "20261002" (Vietnam date) for an instant. */
export function vnDayOf(at: Date): string {
  const vn = new Date(at.getTime() + 7 * 3600_000);
  return `${vn.getUTCFullYear()}${String(vn.getUTCMonth() + 1).padStart(2, '0')}${String(vn.getUTCDate()).padStart(2, '0')}`;
}

export const costBucketSchema = z.object({
  key: z.string(),
  label: z.string(),
  cost: z.number().int(),
  requests: z.number().int(),
});
export type CostBucket = z.infer<typeof costBucketSchema>;

export const dailyPointSchema = z.object({
  day: z.string(),
  cost: z.number().int(),
  requests: z.number().int(),
  /** Distinct users that day (university scope only). */
  users: z.number().int().nullable(),
});
export type DailyPoint = z.infer<typeof dailyPointSchema>;

export const dashboardSchema = z.object({
  period: z.string(),
  departmentId: z.string().nullable(),
  departmentName: z.string(),
  totalCost: z.number().int(),
  requests: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cachedTokens: z.number().int(),
  /** Budget of the scope (unit budget, or the root unit's budget for the university). */
  budget: z.number().int().nullable(),
  percentOfBudget: z.number().nullable(),
  /** End-of-month projection from the last 7 days' pace. */
  forecast: z.number().int(),
  /** Users with at least one request this period / today. */
  activeUsers: z.number().int(),
  activeToday: z.number().int(),
  byProvider: z.array(costBucketSchema),
  byModel: z.array(costBucketSchema),
  byTier: z.array(costBucketSchema),
  byDepartment: z.array(costBucketSchema),
  byDay: z.array(dailyPointSchema),
  aggregatedAt: z.string().nullable(),
  vndPerUsd: z.number(),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

export const myUsageSchema = z.object({
  period: z.string(),
  quota: quotaSummarySchema,
  totalCost: z.number().int(),
  requests: z.number().int(),
  byModel: z.array(costBucketSchema),
  byDay: z.array(dailyPointSchema),
  vndPerUsd: z.number(),
});
export type MyUsage = z.infer<typeof myUsageSchema>;

export const NOTIFICATION_TYPES = [
  'quota_80',
  'unit_budget_80',
  'university_budget',
  'forecast_over_budget',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const notificationSchema = z.object({
  id: z.string(),
  type: z.enum(NOTIFICATION_TYPES),
  title: z.string(),
  message: z.string(),
  createdAt: z.string(),
  read: z.boolean(),
});
export type AppNotification = z.infer<typeof notificationSchema>;
export const notificationListResponseSchema = z.object({
  notifications: z.array(notificationSchema),
  unread: z.number().int(),
});
export const markNotificationsReadRequestSchema = z
  .object({ ids: z.array(z.string().min(1).max(64)).max(200).optional() })
  .strict();

export const exchangeRateSchema = z.object({
  vndPerUsd: z.number().int().min(1000).max(1_000_000),
});
export type ExchangeRate = z.infer<typeof exchangeRateSchema>;

export const USAGE_EXPORT_KINDS = ['departments', 'users', 'models'] as const;
export type UsageExportKind = (typeof USAGE_EXPORT_KINDS)[number];

/** University-wide alert thresholds (spec 8.13), % of the root budget. */
export const UNIVERSITY_ALERT_THRESHOLDS = [50, 70, 80, 90, 100] as const;
export const USER_ALERT_PERCENT = 80;
export const UNIT_ALERT_PERCENT = 80;

function shiftDay(day: string, delta: number): string {
  const d = new Date(
    Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)) + delta),
  );
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * End-of-month projection (spec 8.13): spend so far plus the average of the last 7 days
 * (fewer early in the month) for each remaining day. Past periods return their total.
 */
export function forecastPeriod(
  totalCost: number,
  byDay: { day: string; cost: number }[],
  period: string,
  now: Date,
): number {
  const today = vnDayOf(now);
  if (today.slice(0, 6) !== period) return totalCost;
  const elapsed = Number(today.slice(6, 8));
  const window = Math.min(7, elapsed);
  const days = new Set(Array.from({ length: window }, (_, i) => shiftDay(today, -i)));
  const recent = byDay.filter((d) => days.has(d.day)).reduce((s, d) => s + d.cost, 0);
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(4, 6));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Math.round(totalCost + (recent / window) * (daysInMonth - elapsed));
}
