import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { DEFAULT_DLP_POLICY, dlpPolicySchema, type DlpPolicy } from '@uniai/shared';
import { COLLECTIONS } from './collections.js';

/** settings/dlp: DLP policy (spec 8.11). Missing or invalid = the defaults. */
export class DlpPolicyStore {
  constructor(private readonly db: Firestore) {}

  private ref() {
    return this.db.collection(COLLECTIONS.settings).doc('dlp');
  }

  async get(): Promise<{
    policy: DlpPolicy;
    updatedBy: string | null;
    updatedAt: string | null;
  }> {
    const snap = await this.ref().get();
    const d = snap.data() ?? {};
    const parsed = dlpPolicySchema.safeParse(d.policy);
    return {
      policy: parsed.success ? parsed.data : DEFAULT_DLP_POLICY,
      updatedBy: (d.updatedBy as string | undefined) ?? null,
      updatedAt: d.updatedAt instanceof Timestamp ? d.updatedAt.toDate().toISOString() : null,
    };
  }

  async set(policy: DlpPolicy, by: string): Promise<void> {
    await this.ref().set({ policy, updatedBy: by, updatedAt: FieldValue.serverTimestamp() });
  }
}
