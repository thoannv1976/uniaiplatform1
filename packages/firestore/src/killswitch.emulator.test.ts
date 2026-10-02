import { DEFAULT_KILL_SWITCH, quotaPeriodOf, type KillSwitch } from '@uniai/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from './admin.js';
import { COLLECTIONS } from './collections.js';
import { runUsageJob } from './jobs.js';
import { KillSwitchStore } from './killswitch.js';
import { QuotaService } from './quota.js';
import { seed } from './seed.js';
import { clearFirestoreEmulator } from './testing.js';

const db = getDb();
const store = new KillSwitchStore(db);
const quota = new QuotaService(db);
const period = quotaPeriodOf(new Date());
const sa = { uid: 'sa', role: 'super_admin' as const, scopeDepartmentId: null };

beforeEach(async () => {
  await clearFirestoreEmulator();
  await seed(db);
});

describe('KillSwitchStore', () => {
  it('defaults to everything on, saves changes and notifies listeners', async () => {
    expect(await store.get()).toEqual(DEFAULT_KILL_SWITCH);
    const seen: KillSwitch[] = [];
    const stop = store.watch(
      (v) => seen.push(v),
      (err) => {
        throw err;
      },
    );
    const saved = await store.set(
      {
        all: false,
        providers: ['openai'],
        models: [],
        tiers: [],
        reason: 'Sự cố OpenAI',
        autoBrakePercent: 90,
      },
      'sa',
    );
    expect(saved).toMatchObject({ providers: ['openai'], auto: false, updatedBy: 'sa' });
    await expect.poll(() => seen.at(-1)?.providers).toEqual(['openai']);
    stop();
  });
});

describe('quota: per-model rate limit', () => {
  it('refuses the request above the model limit with a wait time', async () => {
    await db.collection(COLLECTIONS.users).doc('u').set({
      email: 'u@ftu.edu.vn',
      role: 'user',
      status: 'active',
      departmentId: null,
      departmentPath: [],
      quotaTierId: 'research',
    });
    const reserve = () =>
      quota.reserve({
        uid: 'u',
        estimate: 10,
        premium: false,
        providerId: 'mock',
        transport: 'direct',
        modelId: 'mock-economy',
        apiModelId: 'mock-economy',
        priceId: 'p',
        conversationId: null,
        routeReason: 'test',
        modelRateLimit: 2,
      });
    await reserve();
    await reserve();
    await expect(reserve()).rejects.toMatchObject({ code: 'rate_limited' });
    // Other models are not affected.
    await expect(
      quota.reserve({
        uid: 'u',
        estimate: 10,
        premium: false,
        providerId: 'mock',
        transport: 'direct',
        modelId: 'mock-advanced',
        apiModelId: 'mock-advanced',
        priceId: 'p',
        conversationId: null,
        routeReason: 'test',
        modelRateLimit: 2,
      }),
    ).resolves.toBeTruthy();
  });
});

describe('emergency brake', () => {
  it('switches off advanced and premium once the university spend reaches the threshold', async () => {
    await db.collection(COLLECTIONS.users).doc('sa').set({
      email: 'sa@ftu.edu.vn',
      role: 'super_admin',
      status: 'active',
      departmentId: null,
      departmentPath: [],
    });
    await db
      .collection(COLLECTIONS.users)
      .doc('u')
      .set({
        email: 'u@ftu.edu.vn',
        role: 'user',
        status: 'active',
        departmentId: 'QTKD',
        departmentPath: ['FTU', 'QTKD'],
        quotaTierId: 'research',
      });
    await quota.setBudget({ id: 'FTU', parentId: null, path: ['FTU'] }, period, 20_000_000, sa);
    const r = await quota.reserve({
      uid: 'u',
      estimate: 19_000_000,
      premium: false,
      providerId: 'mock',
      transport: 'direct',
      modelId: 'mock-economy',
      apiModelId: 'mock-economy',
      priceId: 'p',
      conversationId: null,
      routeReason: 'test',
    });
    const commit = (cost: number) =>
      quota.commit(r, {
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
        costInput: cost,
        costCachedInput: 0,
        costOutput: 0,
        totalCost: cost,
        outcome: 'complete',
        messageId: null,
        conversationId: null,
        latencyMs: 1,
      });
    await commit(18_000_000);
    const later = new Date(Date.now() + 60_000);
    await store.set(
      { all: false, providers: [], models: [], tiers: [], reason: '', autoBrakePercent: 90 },
      'sa',
    );
    expect((await runUsageJob(db, later)).braked).toBe(true);
    expect(await store.get()).toMatchObject({ tiers: ['advanced', 'premium'], auto: true });
    expect((await store.get()).reason).toContain('Phanh khẩn cấp');
    // Once only.
    expect((await runUsageJob(db, later)).braked).toBe(false);
    const notes = await db.collection('notifications').where('uid', '==', 'sa').get();
    expect(
      notes.docs.some((d) => d.get('title') === 'Đã tự bật phanh khẩn cấp (kill switch)'),
    ).toBe(true);
  });

  it('does nothing when the brake is disabled', async () => {
    await store.set(
      { all: false, providers: [], models: [], tiers: [], reason: '', autoBrakePercent: null },
      'sa',
    );
    expect((await runUsageJob(db, new Date(Date.now() + 60_000))).braked).toBe(false);
  });
});
