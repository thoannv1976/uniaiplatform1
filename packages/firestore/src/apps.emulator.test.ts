import { APP_KEY_PATTERN, quotaPeriodOf, usdToMicro } from '@uniai/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from './admin.js';
import { UsageAggregator } from './aggregate.js';
import { AppClientStore } from './apps.js';
import { COLLECTIONS } from './collections.js';
import { QuotaService } from './quota.js';
import { seed } from './seed.js';
import { clearFirestoreEmulator } from './testing.js';

const db = getDb();
const apps = new AppClientStore(db);
const quota = new QuotaService(db);
const period = quotaPeriodOf(new Date());
const sa = { uid: 'sa', role: 'super_admin' as const, scopeDepartmentId: null };
const KTQT = { id: 'KTQT', path: ['FTU', 'KTQT'] };

const input = (over: Record<string, unknown> = {}) => ({
  name: 'LMS',
  description: 'Hệ thống học tập',
  ownerDepartmentId: 'KTQT',
  scopes: ['chat' as const, 'usage' as const],
  monthlyBudget: usdToMicro(5),
  requestsPerMinute: 2,
  allowAdvanced: false,
  ...over,
});

const reserveFor = (clientId: string, estimate: number) =>
  quota.reserve({
    uid: 'ignored',
    appClientId: clientId,
    reference: 'lms-123',
    estimate,
    premium: false,
    providerId: 'mock',
    transport: 'direct',
    modelId: 'mock-economy',
    modelTier: 'economy',
    apiModelId: 'mock-economy',
    priceId: 'p',
    conversationId: null,
    routeReason: 'test',
  });

beforeEach(async () => {
  await clearFirestoreEmulator();
  await seed(db);
});

describe('AppClientStore', () => {
  it('stores only a hash, verifies keys in constant time and rotates them', async () => {
    const { client, key } = await apps.create(input(), KTQT, 'sa');
    expect(key).toMatch(APP_KEY_PATTERN);
    expect(client).toMatchObject({ name: 'LMS', status: 'active', keyLast4: key.slice(-4) });
    const raw = (await db.collection(COLLECTIONS.appClients).doc(client.id).get()).data()!;
    expect(JSON.stringify(raw)).not.toContain(key.split('_').at(-1)!);
    expect(raw.keyHash).toMatch(/^[0-9a-f]{64}$/);

    expect((await apps.verify(key))?.client.id).toBe(client.id);
    expect((await apps.verify(key))?.departmentPath).toEqual(['FTU', 'KTQT']);
    const tampered = key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A');
    expect(await apps.verify(tampered)).toBeNull();
    expect(await apps.verify('uak_short')).toBeNull();
    expect(await apps.verify(`Bearer ${key}`)).toBeNull();

    const rotated = await apps.rotate(client.id, 'sa');
    expect(rotated.key).not.toBe(key);
    expect(await apps.verify(key)).toBeNull();
    expect((await apps.verify(rotated.key))?.client.rotatedAt).not.toBeNull();
  });

  it('counts app budgets in the unit allocation and never beyond the unit budget', async () => {
    await quota.setBudget(
      { id: 'FTU', parentId: null, path: ['FTU'] },
      period,
      usdToMicro(100),
      sa,
    );
    await quota.setBudget(
      { id: 'KTQT', parentId: 'FTU', path: ['FTU', 'KTQT'] },
      period,
      usdToMicro(10),
      sa,
    );
    const { client } = await apps.create(input({ monthlyBudget: usdToMicro(6) }), KTQT, 'sa');
    await expect(
      apps.create(input({ name: 'Cổng SV', monthlyBudget: usdToMicro(5) }), KTQT, 'sa'),
    ).rejects.toMatchObject({ message: expect.stringMatching(/Vượt ngân sách đơn vị KTQT/) });
    await expect(
      apps.update(client.id, { monthlyBudget: usdToMicro(11) }, 'sa'),
    ).rejects.toMatchObject({ code: 'invalid' });
    await apps.update(client.id, { monthlyBudget: usdToMicro(9) }, 'sa');
    // The unit cannot drop its budget below what its apps were given.
    await expect(
      quota.setBudget(
        { id: 'KTQT', parentId: 'FTU', path: ['FTU', 'KTQT'] },
        period,
        usdToMicro(8),
        sa,
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/cán bộ và ứng dụng/) });
    // A disabled app frees its share; switching it back on checks again.
    await apps.update(client.id, { status: 'disabled' }, 'sa');
    await apps.create(input({ name: 'Cổng SV', monthlyBudget: usdToMicro(5) }), KTQT, 'sa');
    await expect(apps.update(client.id, { status: 'active' }, 'sa')).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('bills apps on their own period and in the ledger, with budget and rate limits', async () => {
    const { client } = await apps.create(input({ monthlyBudget: 30_000 }), KTQT, 'sa');
    const r = await reserveFor(client.id, 10_000);
    expect(r).toMatchObject({ uid: `app:${client.id}`, appClientId: client.id });
    await quota.commit(r, {
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0 },
      costInput: 7000,
      costCachedInput: 0,
      costOutput: 0,
      totalCost: 7000,
      outcome: 'complete',
      messageId: null,
      conversationId: null,
      latencyMs: 5,
    });
    expect(await quota.appUsage(client.id)).toEqual({ used: 7000, reserved: 0 });
    const ledger = (await db.collection(COLLECTIONS.usageTransactions).doc(r.txnId).get()).data()!;
    expect(ledger).toMatchObject({
      status: 'committed',
      uid: `app:${client.id}`,
      appClientId: client.id,
      reference: 'lms-123',
      departmentPath: ['FTU', 'KTQT'],
      totalCost: 7000,
    });

    // Second request in the minute is fine, the third hits the rate limit (2/min).
    const r2 = await reserveFor(client.id, 1000);
    await expect(reserveFor(client.id, 1000)).rejects.toMatchObject({ code: 'rate_limited' });
    await quota.release(r2);
    expect(await quota.appUsage(client.id)).toEqual({ used: 7000, reserved: 0 });

    await apps.update(client.id, { requestsPerMinute: 100 }, 'sa');
    await expect(reserveFor(client.id, 30_000)).rejects.toMatchObject({ code: 'quota_exceeded' });
    await apps.update(client.id, { status: 'disabled' }, 'sa');
    await expect(reserveFor(client.id, 10)).rejects.toMatchObject({ code: 'forbidden' });

    // The aggregation counts the app for its unit, not as a user.
    const agg = new UsageAggregator(db);
    await agg.run(new Date(Date.now() + 60_000));
    const p = await agg.period(period);
    expect(p.byApp[client.id]?.cost).toBe(7000);
    expect(p.byUser).toEqual({});
    expect(p.byDepartment.KTQT?.cost).toBe(7000);
  });

  it('releases an app reservation left behind', async () => {
    const { client } = await apps.create(input(), KTQT, 'sa');
    await reserveFor(client.id, 5000);
    expect(await quota.sweepReservations(new Date(Date.now() + 11 * 60_000))).toBe(1);
    expect(await quota.appUsage(client.id)).toEqual({ used: 0, reserved: 0 });
  });
});
