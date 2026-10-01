import { pathToFileURL } from 'node:url';
import type { Firestore } from 'firebase-admin/firestore';
import { getDb, isEmulator } from './admin.js';
import { COLLECTIONS } from './collections.js';
import { APP_SETTINGS, QUOTA_TIERS, SAMPLE_DEPARTMENTS } from './seed-data.js';

/** Idempotent: re-running overwrites the same documents. */
export async function seed(db: Firestore): Promise<void> {
  const batch = db.batch();
  for (const tier of QUOTA_TIERS) {
    batch.set(db.collection(COLLECTIONS.quotaTiers).doc(tier.id), tier);
  }
  for (const dept of SAMPLE_DEPARTMENTS) {
    const { id, ...data } = dept;
    batch.set(db.collection(COLLECTIONS.departments).doc(id), { ...data, status: 'active' });
  }
  batch.set(db.collection(COLLECTIONS.settings).doc('app'), APP_SETTINGS);
  await batch.commit();
}

async function main(): Promise<void> {
  if (!isEmulator() && !process.argv.includes('--allow-remote')) {
    console.error(
      'Từ chối seed: FIRESTORE_EMULATOR_HOST chưa được đặt. ' +
        'Chỉ seed vào project thật khi có chủ đích, bằng cờ --allow-remote.',
    );
    process.exit(1);
  }
  await seed(getDb());
  console.log('Đã seed dữ liệu mẫu.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
