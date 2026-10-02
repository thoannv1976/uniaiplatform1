import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { ChatUsage, ProviderId, Transport } from '@uniai/shared';
import { COLLECTIONS } from './collections.js';

/** One AI request in the cost ledger (spec 8.7, 9). Written once; never updated or deleted. */
export interface UsageRecord {
  uid: string;
  departmentId: string | null;
  /** Ancestor department ids, for unit-level totals without hot documents. */
  departmentPath: string[];
  appClientId: string | null;
  providerId: ProviderId;
  transport: Transport;
  modelId: string;
  apiModelId: string;
  priceId: string;
  usage: ChatUsage;
  /** micro-USD, split as in spec 9. */
  costInput: number;
  costCachedInput: number;
  costOutput: number;
  totalCost: number;
  /** Amount held before the call; quota reservations arrive in M7. */
  reservedCost: number;
  conversationId: string | null;
  messageId: string | null;
  routeReason: string;
  fallbackFrom: string | null;
  /** complete | cancelled | error – how the answer ended; the cost is final either way. */
  outcome: 'complete' | 'cancelled' | 'error';
  requestTime: Date;
  responseTime: Date;
  latencyMs: number;
}

export class UsageStore {
  constructor(private readonly db: Firestore) {}

  /** Appends a committed ledger entry and returns its id. */
  async record(entry: UsageRecord): Promise<string> {
    const ref = this.db.collection(COLLECTIONS.usageTransactions).doc();
    await ref.create({
      ...entry,
      status: 'committed',
      requestTime: Timestamp.fromDate(entry.requestTime),
      responseTime: Timestamp.fromDate(entry.responseTime),
      committedAt: FieldValue.serverTimestamp(),
    });
    return ref.id;
  }

  /** Ledger entries of one user, newest first (tests and the M8 usage page). */
  async listForUser(uid: string, limit = 100) {
    const snap = await this.db
      .collection(COLLECTIONS.usageTransactions)
      .where('uid', '==', uid)
      .orderBy('requestTime', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map(
      (d) => ({ id: d.id, ...d.data() }) as UsageRecord & { id: string; status: string },
    );
  }
}
