import { quotaPeriodOf, usdToMicro } from '@uniai/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from './admin.js';
import { COLLECTIONS } from './collections.js';
import { QuotaError, QuotaService, type ReserveInput } from './quota.js';
import { seed } from './seed.js';
import { clearFirestoreEmulator } from './testing.js';

const db = getDb();
const quota = new QuotaService(db);
const period = quotaPeriodOf(new Date());
const sa = { uid: 'sa', role: 'super_admin' as const, scopeDepartmentId: null };

async function givenUser(
  uid: string,
  dept: string,
  path: string[],
  tier = 'standard',
  role = 'user',
) {
  await db
    .collection(COLLECTIONS.users)
    .doc(uid)
    .set({
      email: `${uid}@ftu.edu.vn`,
      name: uid,
      role,
      status: 'active',
      departmentId: dept,
      departmentPath: path,
      quotaTierId: tier,
    });
}

const req = (uid: string, estimate: number, premium = false): ReserveInput => ({
  uid,
  estimate,
  premium,
  providerId: 'mock',
  transport: 'direct',
  modelId: 'mock-economy',
  apiModelId: 'mock-economy',
  priceId: 'p1',
  conversationId: null,
  routeReason: 'test',
});
const settle = (totalCost: number) => ({
  usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 },
  costInput: totalCost,
  costCachedInput: 0,
  costOutput: 0,
  totalCost,
  outcome: 'complete' as const,
  messageId: 'm',
  conversationId: 'c',
  latencyMs: 5,
});

beforeEach(async () => {
  await clearFirestoreEmulator();
  await seed(db);
  await givenUser('gv', 'KTQT-KTVM', ['FTU', 'KTQT', 'KTQT-KTVM']);
});

describe('reserve and commit', () => {
  it('holds the estimate, then settles the real cost in the user document and the ledger', async () => {
    const r = await quota.reserve(req('gv', 100_000));
    expect(await quota.summary('gv')).toMatchObject({
      limit: 2_000_000,
      reserved: 100_000,
      used: 0,
    });
    await quota.commit(r, settle(30_000));
    expect(await quota.summary('gv')).toMatchObject({
      reserved: 0,
      used: 30_000,
      remaining: 1_970_000,
      percentUsed: 1.5,
    });
    const txn = await db.collection(COLLECTIONS.usageTransactions).doc(r.txnId).get();
    expect(txn.data()).toMatchObject({
      status: 'committed',
      reservedCost: 100_000,
      totalCost: 30_000,
      period,
    });
    // Committing twice changes nothing.
    await quota.commit(r, settle(30_000));
    expect((await quota.summary('gv'))?.used).toBe(30_000);
  });

  it('never lets 50 parallel requests of one user exceed the limit', async () => {
    await quota.updateTier('standard', { requestsPerMinute: 1000 }, 'test');
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => quota.reserve(req('gv', 50_000))),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const refused = results.filter(
      (r) =>
        r.status === 'rejected' &&
        r.reason instanceof QuotaError &&
        r.reason.code === 'quota_exceeded',
    ).length;
    expect(ok).toBeLessThanOrEqual(40); // $2 / $0.05
    expect(ok + refused).toBeGreaterThan(0);
    const s = await quota.summary('gv');
    expect(s!.used + s!.reserved).toBeLessThanOrEqual(s!.limit);
    expect(s!.reserved).toBe(ok * 50_000);
  }, 120_000);

  it('refuses with 402-style errors in Vietnamese, premium separately, and rate-limits', async () => {
    await expect(quota.reserve(req('gv', 3_000_000))).rejects.toMatchObject({
      code: 'quota_exceeded',
      message: expect.stringMatching(/không đủ/),
    });
    await expect(quota.reserve(req('gv', 600_000, true))).rejects.toMatchObject({
      code: 'premium_exceeded',
    });
    for (let i = 0; i < 10; i++) await quota.reserve(req('gv', 1));
    const err = await quota.reserve(req('gv', 1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaError);
    expect(err).toMatchObject({ code: 'rate_limited' });
    expect((err as QuotaError).retryAfterSeconds).toBeGreaterThan(0);
  });

  it('releases unbilled requests and sweeps stale reservations; a late commit still counts', async () => {
    const released = await quota.reserve(req('gv', 100_000));
    await quota.release(released);
    expect((await quota.summary('gv'))?.reserved).toBe(0);

    const old = new Date(Date.now() - 11 * 60_000);
    const stale = await quota.reserve({ ...req('gv', 200_000, true), now: old });
    expect(await quota.sweepReservations()).toBe(1);
    expect(await quota.summary('gv')).toMatchObject({ reserved: 0, premiumReserved: 0 });
    await quota.commit(stale, settle(5_000));
    expect(await quota.summary('gv')).toMatchObject({
      used: 5_000,
      premiumUsed: 5_000,
      reserved: 0,
    });
  });

  it('ledger reconciles with the users’ used amounts', async () => {
    await givenUser('gv2', 'QTKD', ['FTU', 'QTKD']);
    for (const [uid, cost] of [
      ['gv', 1234],
      ['gv', 4321],
      ['gv2', 999],
    ] as const) {
      const r = await quota.reserve(req(uid, 10_000));
      await quota.commit(r, settle(cost));
    }
    const ledger = await db
      .collection(COLLECTIONS.usageTransactions)
      .where('status', '==', 'committed')
      .get();
    const ledgerTotal = ledger.docs.reduce((s, d) => s + (d.get('totalCost') as number), 0);
    const users = await quota.list(period);
    expect(users.reduce((s, u) => s + u.used, 0)).toBe(ledgerTotal);
    expect(ledgerTotal).toBe(1234 + 4321 + 999);
  });
});

describe('adjustments and budgets', () => {
  it('adjusts with reason, respects unit budgets and unit admin scope', async () => {
    await givenUser('gv2', 'KTQT', ['FTU', 'KTQT']);
    const ktqt = { id: 'KTQT', parentId: 'FTU', path: ['FTU', 'KTQT'] };
    await expect(quota.setBudget(ktqt, period, usdToMicro(3), sa)).rejects.toMatchObject({
      code: 'invalid',
    }); // 2 staff × $2
    await quota.setBudget(ktqt, period, usdToMicro(5), sa);

    const adj = await quota.adjust(
      {
        uid: 'gv',
        type: 'increase',
        kind: 'monthly',
        amount: usdToMicro(1),
        reason: 'Đề tài NCKH cấp trường',
        approvedBy: 'Trưởng khoa',
      },
      sa,
    );
    expect(adj).toMatchObject({ delta: 1_000_000, period, createdBy: 'sa' });
    await expect(
      quota.adjust(
        {
          uid: 'gv',
          type: 'increase',
          kind: 'monthly',
          amount: 1,
          reason: 'Thêm nữa',
          approvedBy: 'X Y',
        },
        sa,
      ),
    ).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/vượt ngân sách/) });
    // Decreases are always allowed.
    await quota.adjust(
      {
        uid: 'gv',
        type: 'decrease',
        kind: 'monthly',
        amount: 500_000,
        reason: 'Điều chỉnh lại',
        approvedBy: 'Trưởng khoa',
      },
      sa,
    );
    expect((await quota.summary('gv'))?.limit).toBe(2_500_000);

    const unitAdmin = { uid: 'ka', role: 'unit_admin' as const, scopeDepartmentId: 'QTKD' };
    await expect(
      quota.adjust(
        {
          uid: 'gv',
          type: 'set',
          kind: 'monthly',
          amount: 0,
          reason: 'Ngoài phạm vi',
          approvedBy: 'A B',
        },
        unitAdmin,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await quota.listAdjustments({ uid: 'gv' })).length).toBe(2);
  });

  it('keeps unit budgets within the parent and above sub-units', async () => {
    const ftu = { id: 'FTU', parentId: null, path: ['FTU'] };
    const ktqt = { id: 'KTQT', parentId: 'FTU', path: ['FTU', 'KTQT'] };
    const qtkd = { id: 'QTKD', parentId: 'FTU', path: ['FTU', 'QTKD'] };
    await quota.setBudget(ftu, period, usdToMicro(10), sa);
    await quota.setBudget(ktqt, period, usdToMicro(6), sa);
    await expect(quota.setBudget(qtkd, period, usdToMicro(5), sa)).rejects.toMatchObject({
      message: expect.stringMatching(/đơn vị cha FTU/),
    });
    await expect(quota.setBudget(ftu, period, usdToMicro(5), sa)).rejects.toMatchObject({
      message: expect.stringMatching(/đơn vị con/),
    });
    const list = await quota.listBudgets(period);
    expect(list.find((b) => b.departmentId === 'KTQT')).toMatchObject({
      budget: 6_000_000,
      allocated: 2_000_000,
    });
    const unitAdmin = { uid: 'ka', role: 'unit_admin' as const, scopeDepartmentId: 'KTQT' };
    await expect(quota.setBudget(ktqt, period, usdToMicro(7), unitAdmin)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('reverts temporary grants and opens periods for everyone', async () => {
    const soon = new Date(Date.now() + 1000).toISOString();
    await quota.adjust(
      {
        uid: 'gv',
        type: 'increase',
        kind: 'monthly',
        amount: 700_000,
        reason: 'Hội thảo tuần này',
        approvedBy: 'Trưởng phòng',
        expiresAt: soon,
      },
      sa,
    );
    expect((await quota.summary('gv'))?.limit).toBe(2_700_000);
    expect(await quota.expireAdjustments(new Date(Date.now() + 5000))).toBe(1);
    expect((await quota.summary('gv'))?.limit).toBe(2_000_000);

    await givenUser('gv3', 'QLDT', ['FTU', 'QLDT'], 'research');
    expect((await quota.rollover()).created).toBe(1); // gv already has this period
    expect(await quota.rollover()).toMatchObject({ created: 0 });
    expect(await quota.summary('gv3')).toMatchObject({ limit: 20_000_000, tierId: 'research' });
  });
});
