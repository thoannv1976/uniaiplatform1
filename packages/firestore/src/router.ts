import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { DEFAULT_ROUTER_CONFIG, routerConfigSchema, type RouterConfig } from '@uniai/shared';
import { COLLECTIONS } from './collections.js';

/** settings/router: Smart Router rules (spec 8.6). Missing or invalid = the defaults. */
export class RouterConfigStore {
  constructor(private readonly db: Firestore) {}

  private ref() {
    return this.db.collection(COLLECTIONS.settings).doc('router');
  }

  async get(): Promise<{
    config: RouterConfig;
    updatedBy: string | null;
    updatedAt: string | null;
  }> {
    const snap = await this.ref().get();
    const d = snap.data() ?? {};
    const parsed = routerConfigSchema.safeParse(d.config);
    return {
      config: parsed.success ? parsed.data : DEFAULT_ROUTER_CONFIG,
      updatedBy: (d.updatedBy as string | undefined) ?? null,
      updatedAt: d.updatedAt instanceof Timestamp ? d.updatedAt.toDate().toISOString() : null,
    };
  }

  async set(config: RouterConfig, by: string): Promise<void> {
    await this.ref().set({ config, updatedBy: by, updatedAt: FieldValue.serverTimestamp() });
  }
}
