import {
  FieldPath,
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase-admin/firestore';
import { vnDayOf } from '@uniai/shared';
import { COLLECTIONS } from './collections.js';

/** Cost and token counters of one bucket (provider, model, department…). */
export interface Counter {
  cost: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** usageAggregates/{YYYYMM}: totals of committed ledger entries, by dimension. */
export interface PeriodAggregate extends Counter {
  period: string;
  byProvider: Record<string, Counter>;
  byModel: Record<string, Counter>;
  byTier: Record<string, Counter>;
  /** Every ancestor of the user's unit gets the cost; "_none" = users without a unit. */
  byDepartment: Record<string, Counter>;
  byDepartmentModel: Record<string, Record<string, Counter>>;
  byUser: Record<string, number>;
  /** Platform API applications (M17); their requests are not counted as users. */
  byApp: Record<string, Counter>;
  aggregatedAt: string | null;
}

/** usageAggregates/{YYYYMM}/days/{YYYYMMDD} */
export interface DayAggregate extends Counter {
  day: string;
  users: Record<string, number>;
  byDepartment: Record<string, Counter>;
}

const AGGREGATES = 'usageAggregates';
const CHECKPOINT = '_checkpoint';
/** Commits younger than this are left for the next run (timestamps settle). */
const SETTLE_MS = 30_000;
const BATCH = 400;

const zero = (): Counter => ({
  cost: 0,
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
});
const num = (v: unknown) => (typeof v === 'number' ? v : 0);

/**
 * Period and Vietnam day of a ledger entry. Entries written before M7 have no `period`:
 * it is derived from the request time (or the commit time) instead of stopping the job.
 */
export function entryTime(e: { get(field: string): unknown }): { period: string; day: string } {
  const ts = (e.get('requestTime') ?? e.get('committedAt')) as Timestamp | undefined;
  const day = vnDayOf(ts instanceof Timestamp ? ts.toDate() : new Date(0));
  const stored = e.get('period');
  const period = typeof stored === 'string' && /^\d{6}$/.test(stored) ? stored : day.slice(0, 6);
  return { period, day };
}

function add(target: Record<string, Counter>, key: string, c: Counter) {
  const t = (target[key] ??= zero());
  t.cost += c.cost;
  t.requests += c.requests;
  t.inputTokens += c.inputTokens;
  t.outputTokens += c.outputTokens;
  t.cachedTokens += c.cachedTokens;
}

function emptyPeriod(period: string): PeriodAggregate {
  return {
    period,
    ...zero(),
    byProvider: {},
    byModel: {},
    byTier: {},
    byDepartment: {},
    byDepartmentModel: {},
    byUser: {},
    byApp: {},
    aggregatedAt: null,
  };
}

function readPeriod(snap: DocumentSnapshot, period: string): PeriodAggregate {
  if (!snap.exists) return emptyPeriod(period);
  const d = snap.data() ?? {};
  return {
    ...emptyPeriod(period),
    ...(d as Partial<PeriodAggregate>),
    aggregatedAt:
      d.aggregatedAt instanceof Timestamp ? d.aggregatedAt.toDate().toISOString() : null,
  };
}

function readDay(snap: DocumentSnapshot, day: string): DayAggregate {
  const d = snap.exists ? (snap.data() ?? {}) : {};
  return { day, ...zero(), users: {}, byDepartment: {}, ...(d as Partial<DayAggregate>) };
}

/**
 * Folds committed ledger entries into per-period and per-day totals (spec 8.13: job every
 * 5 minutes). Incremental and exactly-once: entries are read in (committedAt, id) order after
 * a checkpoint, and totals plus the new checkpoint are written in one transaction.
 */
export class UsageAggregator {
  constructor(private readonly db: Firestore) {}

  private col() {
    return this.db.collection(AGGREGATES);
  }

  /** Runs until caught up; returns how many ledger entries were added. */
  async run(now = new Date()): Promise<number> {
    let total = 0;
    for (;;) {
      const added = await this.step(now);
      total += added;
      if (added < BATCH) return total;
    }
  }

  private async step(now: Date): Promise<number> {
    const cutoff = Timestamp.fromMillis(now.getTime() - SETTLE_MS);
    const checkpointRef = this.col().doc(CHECKPOINT);
    return this.db.runTransaction(async (tx) => {
      const cp = await tx.get(checkpointRef);
      let query = this.db
        .collection(COLLECTIONS.usageTransactions)
        .where('status', '==', 'committed')
        .where('committedAt', '<=', cutoff)
        .orderBy('committedAt')
        .orderBy(FieldPath.documentId())
        .limit(BATCH);
      if (cp.exists) query = query.startAfter(cp.get('committedAt'), cp.get('id'));
      const entries = await tx.get(query);
      if (entries.empty) return 0;

      const periods = new Map<string, PeriodAggregate>();
      const days = new Map<string, DayAggregate>();
      const periodKeys = new Set<string>();
      const dayKeys = new Set<string>();
      for (const e of entries.docs) {
        const { period, day } = entryTime(e);
        periodKeys.add(period);
        dayKeys.add(`${period}/${day}`);
      }
      const periodSnaps = await tx.getAll(...[...periodKeys].map((p) => this.col().doc(p)));
      [...periodKeys].forEach((p, i) => periods.set(p, readPeriod(periodSnaps[i]!, p)));
      const dayRefs = [...dayKeys].map((k) => {
        const [p, d] = k.split('/') as [string, string];
        return this.col().doc(p).collection('days').doc(d);
      });
      const daySnaps = await tx.getAll(...dayRefs);
      [...dayKeys].forEach((k, i) => days.set(k, readDay(daySnaps[i]!, k.split('/')[1]!)));

      for (const e of entries.docs) {
        const { period, day } = entryTime(e);
        const usage = (e.get('usage') ?? {}) as Record<string, unknown>;
        const c: Counter = {
          cost: num(e.get('totalCost')),
          requests: 1,
          inputTokens: num(usage.inputTokens),
          outputTokens: num(usage.outputTokens),
          cachedTokens: num(usage.cachedInputTokens),
        };
        const uid = e.get('uid') as string;
        const model = e.get('modelId') as string;
        const path = (e.get('departmentPath') as string[] | undefined) ?? [];
        const depts = path.length ? path : ['_none'];

        const p = periods.get(period)!;
        p.cost += c.cost;
        p.requests += 1;
        p.inputTokens += c.inputTokens;
        p.outputTokens += c.outputTokens;
        p.cachedTokens += c.cachedTokens;
        add(p.byProvider, e.get('providerId') as string, c);
        add(p.byModel, model, c);
        add(p.byTier, (e.get('modelTier') as string | null) ?? 'unknown', c);
        for (const d of depts) {
          add(p.byDepartment, d, c);
          add((p.byDepartmentModel[d] ??= {}), model, c);
        }
        const appClientId = e.get('appClientId') as string | null | undefined;
        if (appClientId) add(p.byApp, appClientId, c);
        else p.byUser[uid] = (p.byUser[uid] ?? 0) + c.cost;

        const dayAgg = days.get(`${period}/${day}`)!;
        dayAgg.cost += c.cost;
        dayAgg.requests += 1;
        dayAgg.inputTokens += c.inputTokens;
        dayAgg.outputTokens += c.outputTokens;
        dayAgg.cachedTokens += c.cachedTokens;
        if (!appClientId) dayAgg.users[uid] = (dayAgg.users[uid] ?? 0) + 1;
        for (const d of depts) add(dayAgg.byDepartment, d, c);
      }

      for (const [period, agg] of periods) {
        tx.set(this.col().doc(period), { ...agg, aggregatedAt: FieldValue.serverTimestamp() });
      }
      days.forEach((agg, key) => {
        const [p, d] = key.split('/') as [string, string];
        tx.set(this.col().doc(p).collection('days').doc(d), agg);
      });
      const last = entries.docs.at(-1)!;
      tx.set(checkpointRef, {
        committedAt: last.get('committedAt'),
        id: last.id,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return entries.size;
    });
  }

  async period(period: string): Promise<PeriodAggregate> {
    return readPeriod(await this.col().doc(period).get(), period);
  }

  async days(period: string): Promise<DayAggregate[]> {
    const snap = await this.col().doc(period).collection('days').get();
    return snap.docs.map((d) => readDay(d, d.id)).sort((a, b) => a.day.localeCompare(b.day));
  }

  /** Copies each unit's period cost into its budget document (usedAggregate). */
  async updateBudgets(
    period: string,
  ): Promise<{ departmentId: string; budget: number; used: number; parentId: string | null }[]> {
    const [agg, budgets] = await Promise.all([
      this.period(period),
      this.db.collection(COLLECTIONS.budgetPeriods).where('period', '==', period).get(),
    ]);
    const out: { departmentId: string; budget: number; used: number; parentId: string | null }[] =
      [];
    const batch = this.db.batch();
    for (const doc of budgets.docs) {
      const dept = doc.get('departmentId') as string;
      const used = agg.byDepartment[dept]?.cost ?? 0;
      batch.update(doc.ref, { usedAggregate: used, aggregatedAt: FieldValue.serverTimestamp() });
      out.push({
        departmentId: dept,
        budget: num(doc.get('budget')),
        used,
        parentId: (doc.get('parentId') as string | null) ?? null,
      });
    }
    if (!budgets.empty) await batch.commit();
    return out;
  }
}
