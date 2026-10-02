import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import {
  MODEL_TIER_LABELS_VI,
  monthlyReportSchema,
  periodEnd,
  previousPeriod,
  PROVIDER_LABELS_VI,
  quotaPeriodOf,
  type CostBucket,
  type Department,
  type ModelTier,
  type MonthlyReport,
  type ProviderId,
  type ReportDepartment,
} from '@uniai/shared';
import { UsageAggregator, type Counter } from './aggregate.js';
import { COLLECTIONS } from './collections.js';
import { DepartmentStore } from './departments.js';
import { QuotaService } from './quota.js';
import { RegistryStore } from './registry.js';
import { SettingsStore } from './settings.js';

const bucket = (key: string, label: string, c: Counter): CostBucket => ({
  key,
  label,
  cost: c.cost,
  requests: c.requests,
});
const byCost = (a: CostBucket, b: CostBucket) => b.cost - a.cost || a.key.localeCompare(b.key);
const pct = (used: number, budget: number | null) =>
  budget ? Math.round((used / budget) * 1000) / 10 : null;

/** Units in tree order (parents first, siblings by name). */
function treeOrder(departments: Department[]): Department[] {
  const children = new Map<string | null, Department[]>();
  for (const d of departments) {
    const list = children.get(d.parentId) ?? [];
    list.push(d);
    children.set(d.parentId, list);
  }
  const out: Department[] = [];
  const walk = (parent: string | null) => {
    for (const d of (children.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(d);
      walk(d.id);
    }
  };
  walk(null);
  return out;
}

/**
 * Builds the report of a month from usageAggregates (never from the ledger), with unit
 * budgets and allocated quotas from budgetPeriods.
 */
export async function buildMonthlyReport(
  db: Firestore,
  period: string,
  now = new Date(),
): Promise<MonthlyReport> {
  const aggregator = new UsageAggregator(db);
  const [agg, days, departments, budgets, models, vndPerUsd] = await Promise.all([
    aggregator.period(period),
    aggregator.days(period),
    new DepartmentStore(db).list(),
    new QuotaService(db).listBudgets(period),
    new RegistryStore(db).listModels(now),
    new SettingsStore(db).exchangeRate(),
  ]);
  const budgetOf = new Map(budgets.map((b) => [b.departmentId, b]));
  const modelInfo = new Map(models.map((m) => [m.id, m]));
  const root = departments.find((d) => d.parentId === null) ?? null;
  const rootBudget = root ? (budgetOf.get(root.id)?.budget ?? null) : null;

  const rows: ReportDepartment[] = treeOrder(departments)
    .filter((d) => d.status === 'active' || (agg.byDepartment[d.id]?.cost ?? 0) > 0)
    .map((d) => {
      const c = agg.byDepartment[d.id];
      const b = budgetOf.get(d.id);
      const cost = c?.cost ?? 0;
      return {
        id: d.id,
        name: d.name,
        parentId: d.parentId,
        depth: Math.max(0, d.path.length - 1),
        cost,
        requests: c?.requests ?? 0,
        inputTokens: c?.inputTokens ?? 0,
        outputTokens: c?.outputTokens ?? 0,
        budget: b?.budget ?? null,
        allocated: b?.allocated ?? null,
        percentOfBudget: pct(cost, b?.budget ?? null),
      };
    });

  const departmentModels: MonthlyReport['departmentModels'] = {};
  for (const [dept, mix] of Object.entries(agg.byDepartmentModel)) {
    departmentModels[dept] = Object.fromEntries(
      Object.entries(mix).map(([m, c]) => [m, { cost: c.cost, requests: c.requests }]),
    );
  }
  const departmentDays: MonthlyReport['departmentDays'] = {};
  for (const day of days) {
    for (const [dept, c] of Object.entries(day.byDepartment)) {
      (departmentDays[dept] ??= {})[day.day] = { cost: c.cost, requests: c.requests };
    }
  }
  const usedModels = new Set([
    ...Object.keys(agg.byModel),
    ...Object.values(agg.byDepartmentModel).flatMap((m) => Object.keys(m)),
  ]);

  return monthlyReportSchema.parse({
    period,
    generatedAt: now.toISOString(),
    final: now.getTime() >= periodEnd(period).getTime(),
    vndPerUsd,
    totalCost: agg.cost,
    requests: agg.requests,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    cachedTokens: agg.cachedTokens,
    activeUsers: Object.keys(agg.byUser).length,
    budget: rootBudget,
    percentOfBudget: pct(agg.cost, rootBudget),
    byProvider: Object.entries(agg.byProvider)
      .map(([p, c]) => bucket(p, PROVIDER_LABELS_VI[p as ProviderId] ?? p, c))
      .sort(byCost),
    byModel: Object.entries(agg.byModel)
      .map(([m, c]) => bucket(m, modelInfo.get(m)?.displayName ?? m, c))
      .sort(byCost),
    byTier: Object.entries(agg.byTier)
      .map(([t, c]) => bucket(t, MODEL_TIER_LABELS_VI[t as ModelTier] ?? 'Khác', c))
      .sort(byCost),
    byDay: days.map((d) => ({
      day: d.day,
      cost: d.cost,
      requests: d.requests,
      users: Object.keys(d.users).length,
    })),
    departments: rows,
    models: [...usedModels].sort().map((id) => {
      const m = modelInfo.get(id);
      return {
        id,
        name: m?.displayName ?? id,
        providerId: m?.providerId ?? 'unknown',
        tier: m?.tier ?? 'unknown',
      };
    }),
    departmentModels,
    departmentDays,
  });
}

/** monthlyReports/{YYYYMM}: derived data, so a run may overwrite it. */
export class MonthlyReportStore {
  constructor(private readonly db: Firestore) {}

  private ref(period: string) {
    return this.db.collection(COLLECTIONS.monthlyReports).doc(period);
  }

  async get(period: string): Promise<MonthlyReport | null> {
    const snap = await this.ref(period).get();
    if (!snap.exists) return null;
    const parsed = monthlyReportSchema.safeParse(snap.get('report'));
    return parsed.success ? parsed.data : null;
  }

  async save(report: MonthlyReport): Promise<void> {
    await this.ref(report.period).set({
      report,
      period: report.period,
      generatedAt: Timestamp.fromDate(new Date(report.generatedAt)),
    });
  }

  /** Periods that have a stored report, newest first. */
  async periods(limit = 24): Promise<string[]> {
    const snap = await this.db
      .collection(COLLECTIONS.monthlyReports)
      .orderBy('period', 'desc')
      .limit(limit)
      .select('period')
      .get();
    return snap.docs.map((d) => d.id);
  }
}

/**
 * Worker /jobs/monthly-report (1st of the month, 01:15): folds the last ledger entries,
 * then stores the report of the month that just ended (or of `period`).
 */
export async function runMonthlyReport(db: Firestore, now = new Date(), period?: string) {
  const target = period ?? previousPeriod(quotaPeriodOf(now));
  await new UsageAggregator(db).run(now);
  const report = await buildMonthlyReport(db, target, now);
  await new MonthlyReportStore(db).save(report);
  return {
    period: target,
    final: report.final,
    totalCost: report.totalCost,
    departments: report.departments.length,
  };
}
