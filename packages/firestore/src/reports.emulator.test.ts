import { periodEnd, quotaPeriodOf, scopeReport, usdToMicro } from '@uniai/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from './admin.js';
import { COLLECTIONS } from './collections.js';
import { QuotaService } from './quota.js';
import { MonthlyReportStore, runMonthlyReport } from './reports.js';
import { seed } from './seed.js';
import { clearFirestoreEmulator } from './testing.js';

const db = getDb();
const quota = new QuotaService(db);
const period = quotaPeriodOf(new Date());
const sa = { uid: 'sa', role: 'super_admin' as const, scopeDepartmentId: null };

async function givenUser(uid: string, path: string[]) {
  await db
    .collection(COLLECTIONS.users)
    .doc(uid)
    .set({
      email: `${uid}@ftu.edu.vn`,
      name: uid,
      role: 'user',
      status: 'active',
      departmentId: path.at(-1) ?? null,
      departmentPath: path,
      quotaTierId: 'research',
      scopeDepartmentId: null,
    });
}

async function spend(uid: string, model: string, cost: number) {
  const r = await quota.reserve({
    uid,
    estimate: cost + 10,
    premium: false,
    providerId: 'mock',
    transport: 'direct',
    modelId: model,
    modelTier: 'economy',
    apiModelId: model,
    priceId: 'p',
    conversationId: null,
    routeReason: 'test',
  });
  await quota.commit(r, {
    usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 },
    costInput: cost,
    costCachedInput: 0,
    costOutput: 0,
    totalCost: cost,
    outcome: 'complete',
    messageId: null,
    conversationId: null,
    latencyMs: 1,
  });
}

beforeEach(async () => {
  await clearFirestoreEmulator();
  await seed(db);
  await quota.updateTier('research', { requestsPerMinute: 1000 }, 'test');
  await givenUser('a', ['FTU', 'KTQT', 'KTQT-KTVM']);
  await givenUser('b', ['FTU', 'QTKD']);
});

describe('monthly reports', () => {
  it('matches the ledger, keeps budgets and narrows to a unit', async () => {
    await quota.setBudget(
      { id: 'FTU', parentId: null, path: ['FTU'] },
      period,
      usdToMicro(100),
      sa,
    );
    await quota.setBudget(
      { id: 'KTQT', parentId: 'FTU', path: ['FTU', 'KTQT'] },
      period,
      usdToMicro(30),
      sa,
    );
    for (let i = 0; i < 12; i++) {
      await spend(i % 3 ? 'a' : 'b', i % 2 ? 'mock-advanced' : 'mock-economy', 10_000 + i);
    }
    // At the end of the month (the job runs on the 1st of the next one).
    const after = new Date(periodEnd(period).getTime() + 3600_000);
    const run = await runMonthlyReport(db, after);
    expect(run).toMatchObject({ period, final: true });

    const report = (await new MonthlyReportStore(db).get(period))!;
    const ledger = await db
      .collection(COLLECTIONS.usageTransactions)
      .where('status', '==', 'committed')
      .get();
    const total = ledger.docs.reduce((s, d) => s + (d.get('totalCost') as number), 0);
    expect(report.totalCost).toBe(total);
    expect(report.requests).toBe(12);
    expect(report.activeUsers).toBe(2);
    expect(report.byModel.reduce((s, b) => s + b.cost, 0)).toBe(total);
    expect(report.byDay.reduce((s, d) => s + d.cost, 0)).toBe(total);
    expect(report.budget).toBe(100_000_000);

    const row = (id: string) => report.departments.find((d) => d.id === id)!;
    expect(report.departments[0]).toMatchObject({ id: 'FTU', depth: 0, cost: total });
    expect(row('KTQT').cost + row('QTKD').cost).toBe(total);
    expect(row('KTQT')).toMatchObject({ depth: 1, budget: 30_000_000 });
    expect(row('KTQT').percentOfBudget).toBeCloseTo((row('KTQT').cost / 30_000_000) * 100, 1);
    expect(row('KTQT-KTVM')).toMatchObject({ depth: 2, cost: row('KTQT').cost, budget: null });
    // Tree order: a unit comes right before its sub-units.
    const ids = report.departments.map((d) => d.id);
    expect(ids.indexOf('KTQT-KTVM')).toBe(ids.indexOf('KTQT') + 1);

    const unit = scopeReport(report, 'KTQT', 'FTU', true);
    expect(unit.totalCost).toBe(row('KTQT').cost);
    expect(unit.departments.map((d) => d.id).sort()).toEqual(['KTQT', 'KTQT-KTVM']);
    expect(unit.byModel.reduce((s, b) => s + b.cost, 0)).toBe(unit.totalCost);
    expect(unit.byDay.reduce((s, d) => s + d.cost, 0)).toBe(unit.totalCost);
    expect(unit.budget).toBe(30_000_000);
    expect(JSON.stringify(unit)).not.toContain('QTKD');

    expect(await new MonthlyReportStore(db).periods()).toEqual([period]);
    // Running again gives the same figures (derived data, overwritten).
    await runMonthlyReport(db, after, period);
    expect((await new MonthlyReportStore(db).get(period))?.totalCost).toBe(total);
  });
});
