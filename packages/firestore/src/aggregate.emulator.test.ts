import { quotaPeriodOf } from '@uniai/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from './admin.js';
import { UsageAggregator } from './aggregate.js';
import { AlertService } from './alerts.js';
import { COLLECTIONS } from './collections.js';
import { runUsageJob } from './jobs.js';
import { QuotaService } from './quota.js';
import { seed } from './seed.js';
import { clearFirestoreEmulator } from './testing.js';

const db = getDb();
const quota = new QuotaService(db);
const period = quotaPeriodOf(new Date());
const later = () => new Date(Date.now() + 60_000);

async function givenUser(uid: string, path: string[], role = 'user') {
  await db
    .collection(COLLECTIONS.users)
    .doc(uid)
    .set({
      email: `${uid}@ftu.edu.vn`,
      name: uid,
      role,
      status: 'active',
      departmentId: path.at(-1) ?? null,
      departmentPath: path,
      quotaTierId: 'research',
      scopeDepartmentId: role === 'unit_admin' ? path.at(-1) : null,
    });
}

async function spend(
  uid: string,
  model: string,
  provider: 'mock' | 'openai',
  cost: number,
  tier = 'economy',
) {
  const r = await quota.reserve({
    uid,
    estimate: cost + 10,
    premium: false,
    providerId: provider,
    transport: 'direct',
    modelId: model,
    modelTier: tier as never,
    apiModelId: model,
    priceId: 'p',
    conversationId: null,
    routeReason: 'test',
  });
  await quota.commit(r, {
    usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 10 },
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
  await givenUser('sa', [], 'super_admin');
  await givenUser('ka', ['FTU', 'KTQT'], 'unit_admin');
});

describe('UsageAggregator', () => {
  it('matches the ledger exactly, incrementally and without double counting', async () => {
    const costs: number[] = [];
    for (let i = 0; i < 60; i++) {
      const cost = 1000 + i * 37;
      costs.push(cost);
      await spend(
        i % 3 ? 'a' : 'b',
        i % 2 ? 'gpt-6.1-sol' : 'mock-economy',
        i % 2 ? 'openai' : 'mock',
        cost,
        i % 2 ? 'advanced' : 'economy',
      );
    }
    const agg = new UsageAggregator(db);
    expect(await agg.run(later())).toBe(60);
    expect(await agg.run(later())).toBe(0);

    const ledger = await db
      .collection(COLLECTIONS.usageTransactions)
      .where('status', '==', 'committed')
      .get();
    const ledgerTotal = ledger.docs.reduce((s, d) => s + (d.get('totalCost') as number), 0);
    const p = await agg.period(period);
    expect(p.cost).toBe(ledgerTotal);
    expect(p.requests).toBe(60);
    expect(Object.values(p.byModel).reduce((s, c) => s + c.cost, 0)).toBe(ledgerTotal);
    expect(p.byModel['gpt-6.1-sol']?.requests).toBe(30);
    expect(p.byTier.advanced!.cost + p.byTier.economy!.cost).toBe(ledgerTotal);
    expect(p.byDepartment.FTU?.cost).toBe(ledgerTotal);
    expect(p.byDepartment.KTQT!.cost + p.byDepartment.QTKD!.cost).toBe(ledgerTotal);
    expect(p.byUser.a! + p.byUser.b!).toBe(ledgerTotal);
    const days = await agg.days(period);
    expect(days.reduce((s, d) => s + d.cost, 0)).toBe(ledgerTotal);
    expect(Object.keys(days.at(-1)!.users).sort()).toEqual(['a', 'b']);

    // New entries are added on the next run.
    await spend('a', 'mock-economy', 'mock', 5000);
    expect(await agg.run(later())).toBe(1);
    expect((await agg.period(period)).cost).toBe(ledgerTotal + 5000);
  });
});

describe('usage job and alerts', () => {
  it('updates unit budgets and alerts once at 80 %', async () => {
    const sa = { uid: 'sa', role: 'super_admin' as const, scopeDepartmentId: null };
    // a and ka (standard, $2 each) are the KTQT staff: $4 allocated of a $4.50 budget.
    for (const uid of ['a', 'ka']) {
      await db.collection(COLLECTIONS.users).doc(uid).update({ quotaTierId: 'standard' });
    }
    await quota.setBudget(
      { id: 'KTQT', parentId: 'FTU', path: ['FTU', 'KTQT'] },
      period,
      4_500_000,
      sa,
    );
    await spend('a', 'mock-economy', 'mock', 1_900_000);
    await spend('ka', 'mock-economy', 'mock', 1_900_000);
    const first = await runUsageJob(db, later());
    expect(first).toMatchObject({ added: 2, budgets: 1, alerts: 1 });
    const budget = await db.collection(COLLECTIONS.budgetPeriods).doc(`KTQT_${period}`).get();
    expect(budget.get('usedAggregate')).toBe(3_800_000);
    expect((await runUsageJob(db, later())).alerts).toBe(0);

    const alerts = new AlertService(db);
    const forKa = await alerts.list('ka');
    expect(forKa.unread).toBe(1);
    expect(forKa.notifications[0]).toMatchObject({ type: 'unit_budget_80' });
    expect((await alerts.list('sa')).unread).toBe(1);
    await alerts.markRead('ka');
    expect((await alerts.list('ka')).unread).toBe(0);
  });

  it('tells a user once when they pass 80 % of their quota', async () => {
    const alerts = new AlertService(db);
    await alerts.checkUser('a', period, 1_000_000, 1_500_000, 2_000_000);
    expect((await alerts.list('a')).unread).toBe(0);
    await alerts.checkUser('a', period, 1_500_000, 1_700_000, 2_000_000);
    await alerts.checkUser('a', period, 1_500_000, 1_900_000, 2_000_000);
    const list = await alerts.list('a');
    expect(list.notifications).toHaveLength(1);
    expect(list.notifications[0]).toMatchObject({
      type: 'quota_80',
      title: expect.stringMatching(/80%/),
    });
  });

  it('raises university thresholds and the forecast alert', async () => {
    const alerts = new AlertService(db);
    const sent = await alerts.checkBudgets(
      period,
      [{ departmentId: 'FTU', parentId: null, budget: 10_000_000, used: 7_500_000 }],
      12_000_000,
    );
    expect(sent).toBe(3); // 50 %, 70 % and the forecast
    const types = (await alerts.list('sa')).notifications.map((n) => n.type).sort();
    expect(types).toEqual(['forecast_over_budget', 'university_budget', 'university_budget']);
  });
});
