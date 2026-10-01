import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { AuditEvent, AuditLog } from '@uniai/shared';
import { COLLECTIONS } from './collections.js';

export interface AuditEntry {
  event: AuditEvent;
  /** uid of the acting user, or e.g. "ops:owner@ftu.edu.vn" / "system". */
  actor: string;
  target?: string | null;
  metadata?: Record<string, unknown>;
}

/** Append-only audit trail. Never update or delete documents in auditLogs. */
export class AuditStore {
  constructor(private readonly db: Firestore) {}

  async append(entry: AuditEntry): Promise<string> {
    const ref = await this.db.collection(COLLECTIONS.auditLogs).add({
      event: entry.event,
      actor: entry.actor,
      target: entry.target ?? null,
      metadata: entry.metadata ?? {},
      at: FieldValue.serverTimestamp(),
    });
    return ref.id;
  }

  async list(limit = 100): Promise<AuditLog[]> {
    const snap = await this.db
      .collection(COLLECTIONS.auditLogs)
      .orderBy('at', 'desc')
      .limit(limit)
      .get();
    return snap.docs.map((d) => ({
      id: d.id,
      at: ((d.get('at') as Timestamp | null) ?? Timestamp.now()).toDate().toISOString(),
      event: d.get('event') as AuditEvent,
      actor: d.get('actor') as string,
      target: (d.get('target') as string | null) ?? null,
      metadata: (d.get('metadata') as Record<string, unknown>) ?? {},
    }));
  }
}
