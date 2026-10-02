import { Inject, Injectable } from '@nestjs/common';
import type {
  AlertService,
  Counter,
  DepartmentStore,
  QuotaService,
  SettingsStore,
  UsageAggregator,
} from '@uniai/firestore';
import {
  forecastPeriod,
  MODEL_TIER_LABELS_VI,
  PROVIDER_LABELS_VI,
  quotaPeriodOf,
  vnDayOf,
  type CostBucket,
  type Dashboard,
  type ModelTier,
  type MyUsage,
  type ProviderId,
} from '@uniai/shared';
import type { Firestore } from 'firebase-admin/firestore';
import { RegistryCache } from '../ai/registry-cache.js';
import { QUOTA_SERVICE } from '../chat/chat.service.js';
import { DEPARTMENT_STORE } from '../departments/departments.controller.js';
import { AGGREGATOR, ALERTS, FIRESTORE, SETTINGS } from './tokens.js';

const bucket = (key: string, label: string, c: Pick<Counter, 'cost' | 'requests'>): CostBucket => ({
  key,
  label,
  cost: c.cost,
  requests: c.requests,
});
const byCost = (a: CostBucket, b: CostBucket) => b.cost - a.cost;

/** Builds dashboards from the 5-minute aggregates (spec 8.13) and personal usage from the ledger. */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(AGGREGATOR) private readonly aggregator: UsageAggregator,
    @Inject(SETTINGS) private readonly settings: SettingsStore,
    @Inject(QUOTA_SERVICE) private readonly quota: QuotaService,
    @Inject(DEPARTMENT_STORE) private readonly departments: DepartmentStore,
    @Inject(FIRESTORE) private readonly db: Firestore,
    @Inject(ALERTS) readonly alerts: AlertService,
    private readonly registry: RegistryCache,
  ) {}

  async dashboard(
    period: string,
    departmentId: string | null,
    now = new Date(),
  ): Promise<Dashboard> {
    const [agg, days, depts, registry, vndPerUsd] = await Promise.all([
      this.aggregator.period(period),
      this.aggregator.days(period),
      this.departments.map(),
      this.registry.get(),
      this.settings.exchangeRate(),
    ]);
    const root = [...depts.values()].find((d) => d.parentId === null) ?? null;
    const scopeId = departmentId ?? root?.id ?? null;
    const modelInfo = new Map(registry.models.map((m) => [m.id, m]));
    const modelLabel = (id: string) => modelInfo.get(id)?.displayName ?? id;

    // Totals and model mix for the scope.
    const scoped = departmentId !== null;
    const total: Counter = scoped
      ? (agg.byDepartment[departmentId] ?? {
          cost: 0,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
        })
      : agg;
    const models: Record<string, Counter> = scoped
      ? (agg.byDepartmentModel[departmentId] ?? {})
      : agg.byModel;
    const byModel = Object.entries(models)
      .map(([id, c]) => bucket(id, modelLabel(id), c))
      .sort(byCost);

    const providers = new Map<string, CostBucket>();
    const tiers = new Map<string, CostBucket>();
    if (scoped) {
      for (const [id, c] of Object.entries(models)) {
        const m = modelInfo.get(id);
        const p = m?.providerId ?? 'unknown';
        const t = m?.tier ?? 'unknown';
        const pb =
          providers.get(p) ??
          bucket(p, PROVIDER_LABELS_VI[p as ProviderId] ?? p, { cost: 0, requests: 0 });
        pb.cost += c.cost;
        pb.requests += c.requests;
        providers.set(p, pb);
        const tb =
          tiers.get(t) ??
          bucket(t, MODEL_TIER_LABELS_VI[t as ModelTier] ?? 'Khác', { cost: 0, requests: 0 });
        tb.cost += c.cost;
        tb.requests += c.requests;
        tiers.set(t, tb);
      }
    } else {
      for (const [p, c] of Object.entries(agg.byProvider)) {
        providers.set(p, bucket(p, PROVIDER_LABELS_VI[p as ProviderId] ?? p, c));
      }
      for (const [t, c] of Object.entries(agg.byTier)) {
        tiers.set(t, bucket(t, MODEL_TIER_LABELS_VI[t as ModelTier] ?? 'Khác', c));
      }
    }

    // Ranking: the scope's direct sub-units.
    const children = [...depts.values()].filter((d) => d.parentId === scopeId);
    const byDepartment = children
      .map((d) => bucket(d.id, d.name, agg.byDepartment[d.id] ?? { cost: 0, requests: 0 }))
      .sort(byCost);

    const byDay = days.map((d) => {
      const c = scoped ? d.byDepartment[departmentId] : d;
      return {
        day: d.day,
        cost: c?.cost ?? 0,
        requests: c?.requests ?? 0,
        users: scoped ? null : Object.keys(d.users).length,
      };
    });

    let activeUsers = Object.keys(agg.byUser).length;
    let activeToday = Object.keys(days.find((d) => d.day === vnDayOf(now))?.users ?? {}).length;
    if (scoped) {
      const people = await this.quota.list(period, departmentId);
      const inScope = new Set(people.map((p) => p.uid));
      activeUsers = people.filter((p) => p.used > 0).length;
      activeToday = Object.keys(days.find((d) => d.day === vnDayOf(now))?.users ?? {}).filter((u) =>
        inScope.has(u),
      ).length;
    }

    const budgetDoc = scopeId
      ? await this.db.collection('budgetPeriods').doc(`${scopeId}_${period}`).get()
      : null;
    const budget = budgetDoc?.exists ? (budgetDoc.get('budget') as number) : null;
    return {
      period,
      departmentId,
      departmentName: scoped
        ? (depts.get(departmentId)?.name ?? departmentId)
        : (root?.name ?? 'Toàn trường'),
      totalCost: total.cost,
      requests: total.requests,
      inputTokens: total.inputTokens,
      outputTokens: total.outputTokens,
      cachedTokens: total.cachedTokens,
      budget,
      percentOfBudget: budget ? Math.round((total.cost / budget) * 1000) / 10 : null,
      forecast: forecastPeriod(total.cost, byDay, period, now),
      activeUsers,
      activeToday,
      byProvider: [...providers.values()].sort(byCost),
      byModel,
      byTier: [...tiers.values()].sort(byCost),
      byDepartment,
      byDay,
      aggregatedAt: agg.aggregatedAt,
      vndPerUsd,
    };
  }

  /** "My usage": straight from the ledger, so it is always current. */
  async myUsage(uid: string, period = quotaPeriodOf(new Date())): Promise<MyUsage | null> {
    const [quota, entries, registry, vndPerUsd] = await Promise.all([
      this.quota.summary(uid, period),
      this.db
        .collection('usageTransactions')
        .where('uid', '==', uid)
        .where('period', '==', period)
        .where('status', '==', 'committed')
        .get(),
      this.registry.get(),
      this.settings.exchangeRate(),
    ]);
    if (!quota) return null;
    const names = new Map(registry.models.map((m) => [m.id, m.displayName]));
    const models = new Map<string, CostBucket>();
    const days = new Map<string, { day: string; cost: number; requests: number; users: null }>();
    let totalCost = 0;
    for (const e of entries.docs) {
      const cost = (e.get('totalCost') as number) ?? 0;
      totalCost += cost;
      const id = e.get('modelId') as string;
      const m = models.get(id) ?? bucket(id, names.get(id) ?? id, { cost: 0, requests: 0 });
      m.cost += cost;
      m.requests += 1;
      models.set(id, m);
      const day = vnDayOf(e.get('requestTime').toDate());
      const d = days.get(day) ?? { day, cost: 0, requests: 0, users: null };
      d.cost += cost;
      d.requests += 1;
      days.set(day, d);
    }
    return {
      period,
      quota,
      totalCost,
      requests: entries.size,
      byModel: [...models.values()].sort(byCost),
      byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
      vndPerUsd,
    };
  }
}
