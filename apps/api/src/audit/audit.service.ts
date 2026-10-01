import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuditEntry, AuditStore } from '@uniai/firestore';

export const AUDIT_STORE = Symbol('AUDIT_STORE');

@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(@Inject(AUDIT_STORE) private readonly store: AuditStore) {}

  /**
   * Writes the entry to Firestore and to stdout as a structured log line (`audit: true`),
   * which Cloud Logging collects; M10 routes these into a retention-locked bucket.
   */
  async record(entry: AuditEntry): Promise<void> {
    console.log(
      JSON.stringify({
        severity: 'NOTICE',
        message: `audit ${entry.event}`,
        audit: true,
        event: entry.event,
        actor: entry.actor,
        target: entry.target ?? null,
        metadata: entry.metadata ?? {},
      }),
    );
    await this.store.append(entry);
  }

  /** For denials on the request path: never turn a 401/403 into a 500. */
  recordQuietly(entry: AuditEntry): void {
    this.record(entry).catch((err: unknown) =>
      this.logger.error(`Không ghi được audit ${entry.event}: ${String(err)}`),
    );
  }
}
