import { describe, expect, it } from 'vitest';
import { getDb } from './admin.js';
import { COLLECTIONS } from './collections.js';
import { seed } from './seed.js';

describe('seed (Firestore emulator)', () => {
  it('writes quota tiers, departments and settings idempotently', async () => {
    const db = getDb();
    await seed(db);
    await seed(db);
    const tiers = await db.collection(COLLECTIONS.quotaTiers).get();
    expect(tiers.size).toBe(3);
    const settings = await db.collection(COLLECTIONS.settings).doc('app').get();
    expect(settings.get('killSwitch.all')).toBe(false);
  });
});
