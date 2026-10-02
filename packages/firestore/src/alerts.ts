import {
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase-admin/firestore';
import {
  formatUsd,
  UNIT_ALERT_PERCENT,
  UNIVERSITY_ALERT_THRESHOLDS,
  USER_ALERT_PERCENT,
  type AppNotification,
  type NotificationType,
} from '@uniai/shared';
import { COLLECTIONS } from './collections.js';

const NOTIFICATIONS = 'notifications';
const ALERT_STATES = 'alertStates';

function toNotification(snap: DocumentSnapshot): AppNotification {
  const d = snap.data() ?? {};
  return {
    id: snap.id,
    type: d.type,
    title: d.title,
    message: d.message,
    createdAt:
      d.createdAt instanceof Timestamp
        ? d.createdAt.toDate().toISOString()
        : new Date(0).toISOString(),
    read: d.read === true,
  };
}

export interface BudgetUsage {
  departmentId: string;
  parentId: string | null;
  budget: number;
  used: number;
}

/**
 * In-app alerts (spec 8.13). Each threshold fires once per period: alertStates/{key} is
 * created first and a second attempt finds it. Every alert is also written to the log as
 * `"alert": true`, so a Cloud Monitoring log-based alert can e-mail it.
 */
export class AlertService {
  constructor(private readonly db: Firestore) {}

  /** Notifies `uids` once for `key`; returns false when this alert was already sent. */
  async notifyOnce(
    key: string,
    uids: string[],
    alert: { type: NotificationType; title: string; message: string },
  ): Promise<boolean> {
    const stateRef = this.db.collection(ALERT_STATES).doc(key);
    try {
      await stateRef.create({
        ...alert,
        recipients: uids,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      if ((err as { code?: number }).code === 6) return false; // ALREADY_EXISTS
      throw err;
    }
    const batch = this.db.batch();
    for (const uid of new Set(uids)) {
      batch.create(this.db.collection(NOTIFICATIONS).doc(), {
        uid,
        ...alert,
        key,
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    console.log(
      JSON.stringify({ severity: 'WARNING', alert: true, key, recipients: uids.length, ...alert }),
    );
    return true;
  }

  async list(
    uid: string,
    limit = 50,
  ): Promise<{ notifications: AppNotification[]; unread: number }> {
    const snap = await this.db.collection(NOTIFICATIONS).where('uid', '==', uid).get();
    const all = snap.docs
      .map(toNotification)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { notifications: all.slice(0, limit), unread: all.filter((n) => !n.read).length };
  }

  async markRead(uid: string, ids?: string[]): Promise<void> {
    const snap = await this.db
      .collection(NOTIFICATIONS)
      .where('uid', '==', uid)
      .where('read', '==', false)
      .get();
    const batch = this.db.batch();
    for (const doc of snap.docs) {
      if (!ids || ids.includes(doc.id)) batch.update(doc.ref, { read: true });
    }
    await batch.commit();
  }

  async superAdmins(): Promise<string[]> {
    return this.admins();
  }

  /** Super admins plus the unit admins of a department (for unit and university alerts). */
  private async admins(departmentId?: string): Promise<string[]> {
    const users = this.db.collection(COLLECTIONS.users);
    const [supers, units] = await Promise.all([
      users.where('role', '==', 'super_admin').get(),
      departmentId
        ? users.where('scopeDepartmentId', '==', departmentId).get()
        : Promise.resolve(null),
    ]);
    const uids = supers.docs.filter((d) => d.get('status') === 'active').map((d) => d.id);
    for (const d of units?.docs ?? []) {
      if (d.get('role') === 'unit_admin' && d.get('status') === 'active') uids.push(d.id);
    }
    return uids;
  }

  /** Right after a commit: tell the user once when they pass 80 % of their monthly quota. */
  async checkUser(
    uid: string,
    period: string,
    usedBefore: number,
    usedAfter: number,
    limit: number,
  ) {
    if (limit <= 0) return;
    const threshold = (limit * USER_ALERT_PERCENT) / 100;
    if (usedBefore >= threshold || usedAfter < threshold) return;
    await this.notifyOnce(`quota80_${uid}_${period}`, [uid], {
      type: 'quota_80',
      title: `Đã dùng ${USER_ALERT_PERCENT}% định mức AI tháng này`,
      message: `Bạn đã dùng ${formatUsd(usedAfter)} trên ${formatUsd(limit)}. Khi hết định mức, hệ thống sẽ tạm dừng cho tới tháng sau hoặc khi đơn vị cấp thêm.`,
    });
  }

  /**
   * After each aggregation: units at 80 % of their budget; the root unit (university) at
   * 50/70/80/90/100 %; and a projection above the university budget.
   */
  async checkBudgets(
    period: string,
    budgets: BudgetUsage[],
    forecastRoot: number | null,
  ): Promise<number> {
    let sent = 0;
    for (const b of budgets) {
      if (b.budget <= 0) continue;
      const pct = (b.used / b.budget) * 100;
      if (b.parentId === null) {
        for (const t of UNIVERSITY_ALERT_THRESHOLDS) {
          if (pct < t) continue;
          const ok = await this.notifyOnce(`university${t}_${period}`, await this.admins(), {
            type: 'university_budget',
            title: `Chi phí AI toàn trường đạt ${t}% ngân sách`,
            message: `Tháng ${period.slice(4)}/${period.slice(0, 4)}: ${formatUsd(b.used)} / ${formatUsd(b.budget)}.`,
          });
          if (ok) sent += 1;
        }
        if (forecastRoot !== null && forecastRoot > b.budget) {
          const ok = await this.notifyOnce(`forecast_${period}`, await this.admins(), {
            type: 'forecast_over_budget',
            title: 'Dự báo chi phí AI vượt ngân sách tháng',
            message: `Dự báo cuối tháng ${formatUsd(forecastRoot)} > ngân sách ${formatUsd(b.budget)}. Cân nhắc giảm định mức hoặc bật kill switch nhóm model cao cấp.`,
          });
          if (ok) sent += 1;
        }
      } else if (pct >= UNIT_ALERT_PERCENT) {
        const ok = await this.notifyOnce(
          `unit80_${b.departmentId}_${period}`,
          await this.admins(b.departmentId),
          {
            type: 'unit_budget_80',
            title: `Đơn vị ${b.departmentId} đã dùng ${UNIT_ALERT_PERCENT}% ngân sách AI`,
            message: `Tháng ${period.slice(4)}/${period.slice(0, 4)}: ${formatUsd(b.used)} / ${formatUsd(b.budget)}.`,
          },
        );
        if (ok) sent += 1;
      }
    }
    return sent;
  }
}
