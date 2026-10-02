import {
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase-admin/firestore';
import {
  AUTO_BRAKE_TIERS,
  DEFAULT_KILL_SWITCH,
  type KillSwitch,
  type UpdateKillSwitchRequest,
} from '@uniai/shared';
import { COLLECTIONS } from './collections.js';

function toKillSwitch(snap: DocumentSnapshot): KillSwitch {
  if (!snap.exists) return DEFAULT_KILL_SWITCH;
  const d = snap.data() ?? {};
  return {
    all: d.all === true,
    providers: Array.isArray(d.providers) ? d.providers : [],
    models: Array.isArray(d.models) ? d.models : [],
    tiers: Array.isArray(d.tiers) ? d.tiers : [],
    reason: typeof d.reason === 'string' ? d.reason : '',
    autoBrakePercent:
      d.autoBrakePercent === null || typeof d.autoBrakePercent === 'number'
        ? (d.autoBrakePercent as number | null)
        : DEFAULT_KILL_SWITCH.autoBrakePercent,
    auto: d.auto === true,
    updatedBy: d.updatedBy ?? null,
    updatedAt: d.updatedAt instanceof Timestamp ? d.updatedAt.toDate().toISOString() : null,
  };
}

/** settings/killSwitch (spec 8.8). */
export class KillSwitchStore {
  constructor(private readonly db: Firestore) {}

  private ref() {
    return this.db.collection(COLLECTIONS.settings).doc('killSwitch');
  }

  async get(): Promise<KillSwitch> {
    return toKillSwitch(await this.ref().get());
  }

  async set(value: UpdateKillSwitchRequest, by: string): Promise<KillSwitch> {
    await this.ref().set({
      ...value,
      auto: false,
      updatedBy: by,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return this.get();
  }

  /** Realtime updates; returns the function that stops listening. */
  watch(onChange: (value: KillSwitch) => void, onError: (err: Error) => void): () => void {
    return this.ref().onSnapshot((snap) => onChange(toKillSwitch(snap)), onError);
  }

  /**
   * Emergency brake (spec 8.7): switches off the advanced and premium tiers once. Returns
   * true when it changed something.
   */
  async brake(reason: string): Promise<boolean> {
    return this.db.runTransaction(async (tx) => {
      const current = toKillSwitch(await tx.get(this.ref()));
      const missing = AUTO_BRAKE_TIERS.filter((t) => !current.tiers.includes(t));
      if (current.all || missing.length === 0) return false;
      tx.set(this.ref(), {
        ...current,
        tiers: [...current.tiers, ...missing],
        reason,
        auto: true,
        updatedBy: 'system:auto-brake',
        updatedAt: FieldValue.serverTimestamp(),
      });
      return true;
    });
  }
}
