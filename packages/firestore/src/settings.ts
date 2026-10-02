import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { DEFAULT_VND_PER_USD } from '@uniai/shared';
import { COLLECTIONS } from './collections.js';

/** settings/app: small configuration values the admin can change (spec 9). */
export class SettingsStore {
  constructor(private readonly db: Firestore) {}

  private ref() {
    return this.db.collection(COLLECTIONS.settings).doc('app');
  }

  async exchangeRate(): Promise<number> {
    const value = (await this.ref().get()).get('exchangeRateVndPerUsd');
    return typeof value === 'number' && value > 0 ? value : DEFAULT_VND_PER_USD;
  }

  async setExchangeRate(vndPerUsd: number, by: string): Promise<void> {
    await this.ref().set(
      { exchangeRateVndPerUsd: vndPerUsd, updatedBy: by, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
  }
}
