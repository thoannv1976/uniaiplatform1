import { z } from 'zod';
import { MODEL_TIER_LABELS_VI, type ModelTier } from './models.js';
import { costBucketSchema, dailyPointSchema, type CostBucket } from './usage.js';

/**
 * Monthly reports (spec 8.13, M16): a snapshot of a closed month, built from the 5-minute
 * aggregates on the 1st of the next month (worker /jobs/monthly-report) and kept in
 * monthlyReports/{YYYYMM}. Unit Admins see their own unit and its sub-units only.
 */

const counterSchema = z.object({ cost: z.number().int(), requests: z.number().int() });

export const reportDepartmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  /** 0 = the root unit. */
  depth: z.number().int(),
  /** Spend of the unit and its sub-units. */
  cost: z.number().int(),
  requests: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  budget: z.number().int().nullable(),
  /** Quotas handed out to the unit's people this month. */
  allocated: z.number().int().nullable(),
  percentOfBudget: z.number().nullable(),
});
export type ReportDepartment = z.infer<typeof reportDepartmentSchema>;

export const reportModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  providerId: z.string(),
  tier: z.string(),
});

export const monthlyReportSchema = z.object({
  period: z.string(),
  generatedAt: z.string(),
  /** False while the month is still running (a preview built on request). */
  final: z.boolean(),
  vndPerUsd: z.number(),
  totalCost: z.number().int(),
  requests: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cachedTokens: z.number().int(),
  activeUsers: z.number().int(),
  budget: z.number().int().nullable(),
  percentOfBudget: z.number().nullable(),
  byProvider: z.array(costBucketSchema),
  byModel: z.array(costBucketSchema),
  byTier: z.array(costBucketSchema),
  byDay: z.array(dailyPointSchema),
  departments: z.array(reportDepartmentSchema),
  /** For Unit Admin views: model mix and days of every unit. */
  models: z.array(reportModelSchema),
  departmentModels: z.record(z.string(), z.record(z.string(), counterSchema)),
  departmentDays: z.record(z.string(), z.record(z.string(), counterSchema)),
});
export type MonthlyReport = z.infer<typeof monthlyReportSchema>;

/** GET /api/reports/monthly: the report as the caller may see it. */
export const monthlyReportViewSchema = monthlyReportSchema
  .omit({ models: true, departmentModels: true, departmentDays: true })
  .extend({
    /** null = whole university. */
    scopeDepartmentId: z.string().nullable(),
    scopeName: z.string(),
    /** The report was stored by the monthly job (false = computed on request). */
    stored: z.boolean(),
  });
export type MonthlyReportView = z.infer<typeof monthlyReportViewSchema>;

export const REPORT_EXPORT_FORMATS = ['xlsx'] as const;

const byCost = (a: CostBucket, b: CostBucket) => b.cost - a.cost || a.key.localeCompare(b.key);

/**
 * The part of a report a viewer may see: the whole university, or one unit and its
 * sub-units (totals, model mix and days recomputed for that unit).
 */
export function scopeReport(
  report: MonthlyReport,
  scopeDepartmentId: string | null,
  rootName: string,
  stored: boolean,
): MonthlyReportView {
  const { models, departmentModels, departmentDays, ...rest } = report;
  if (scopeDepartmentId === null) {
    return { ...rest, scopeDepartmentId: null, scopeName: rootName, stored };
  }
  const own = report.departments.find((d) => d.id === scopeDepartmentId);
  // Sub-units: rows below the scope, found through the parent links.
  const inScope = new Set([scopeDepartmentId]);
  for (const d of report.departments) {
    if (d.parentId && inScope.has(d.parentId)) inScope.add(d.id);
  }
  const departments = report.departments.filter((d) => inScope.has(d.id));
  const info = new Map(models.map((m) => [m.id, m]));
  const mix = departmentModels[scopeDepartmentId] ?? {};
  const byModel: CostBucket[] = [];
  const providers = new Map<string, CostBucket>();
  const tiers = new Map<string, CostBucket>();
  for (const [id, c] of Object.entries(mix)) {
    const m = info.get(id);
    byModel.push({ key: id, label: m?.name ?? id, ...c });
    const p = m?.providerId ?? 'unknown';
    const pb = providers.get(p) ?? {
      key: p,
      label: report.byProvider.find((b) => b.key === p)?.label ?? p,
      cost: 0,
      requests: 0,
    };
    pb.cost += c.cost;
    pb.requests += c.requests;
    providers.set(p, pb);
    const t = m?.tier ?? 'unknown';
    const tb = tiers.get(t) ?? {
      key: t,
      label: MODEL_TIER_LABELS_VI[t as ModelTier] ?? 'Khác',
      cost: 0,
      requests: 0,
    };
    tb.cost += c.cost;
    tb.requests += c.requests;
    tiers.set(t, tb);
  }
  const days = departmentDays[scopeDepartmentId] ?? {};
  return {
    ...rest,
    totalCost: own?.cost ?? 0,
    requests: own?.requests ?? 0,
    inputTokens: own?.inputTokens ?? 0,
    outputTokens: own?.outputTokens ?? 0,
    cachedTokens: 0,
    // Active users per unit are not part of the aggregates.
    activeUsers: 0,
    budget: own?.budget ?? null,
    percentOfBudget: own?.percentOfBudget ?? null,
    byModel: byModel.sort(byCost),
    byProvider: [...providers.values()].sort(byCost),
    byTier: [...tiers.values()].sort(byCost),
    byDay: report.byDay.map((d) => ({
      day: d.day,
      cost: days[d.day]?.cost ?? 0,
      requests: days[d.day]?.requests ?? 0,
      users: null,
    })),
    departments,
    scopeDepartmentId,
    scopeName: own?.name ?? scopeDepartmentId,
    stored,
  };
}

/** "202609" → "202608". */
export function previousPeriod(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(4, 6));
  return month === 1 ? `${year - 1}12` : `${year}${String(month - 1).padStart(2, '0')}`;
}

/** "202610" → "10/2026". */
export function periodLabel(period: string): string {
  return `${period.slice(4, 6)}/${period.slice(0, 4)}`;
}
