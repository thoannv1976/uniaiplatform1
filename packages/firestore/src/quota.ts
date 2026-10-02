import {
  FieldValue,
  Timestamp,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Query,
  type Transaction,
} from 'firebase-admin/firestore';
import {
  DEFAULT_QUOTA_TIERS,
  formatUsd,
  QUOTA_TIER_IDS,
  quotaPeriodOf,
  type Budget,
  type ChatUsage,
  type ProviderId,
  type QuotaAdjustment,
  type QuotaAdjustmentRequest,
  type QuotaPeriodDoc,
  type QuotaSummary,
  type QuotaTier,
  type QuotaTierId,
  type Role,
  type Transport,
  type UpdateQuotaTierRequest,
} from '@uniai/shared';
import { COLLECTIONS } from './collections.js';

export type QuotaErrorCode =
  'quota_exceeded' | 'premium_exceeded' | 'rate_limited' | 'not_found' | 'forbidden' | 'invalid';

export class QuotaError extends Error {
  constructor(
    message: string,
    readonly code: QuotaErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** Who is changing quotas: Super Admin anywhere, Unit Admin inside their unit (users only). */
export interface QuotaActor {
  uid: string;
  role: Role;
  scopeDepartmentId: string | null;
}

export interface ReserveInput {
  uid: string;
  /** Worst-case cost (input estimate + max output) in micro-USD. */
  estimate: number;
  /** Advanced/premium model: also counts against the premium budget. */
  premium: boolean;
  providerId: ProviderId;
  transport: Transport;
  modelId: string;
  apiModelId: string;
  priceId: string;
  conversationId: string | null;
  routeReason: string;
  fallbackFrom?: string | null;
  now?: Date;
}

export interface Reservation {
  txnId: string;
  uid: string;
  period: string;
  estimate: number;
  premium: boolean;
}

export interface CommitInput {
  usage: ChatUsage;
  costInput: number;
  costCachedInput: number;
  costOutput: number;
  totalCost: number;
  outcome: 'complete' | 'cancelled' | 'error';
  messageId: string | null;
  conversationId: string | null;
  latencyMs: number;
  responseTime?: Date;
}

const WINDOW_MS = 60_000;
/** Reservations older than this are released by the sweeper (spec 8.7: 10 minutes). */
export const RESERVATION_TTL_MS = 10 * 60_000;

const iso = (t: unknown) => (t instanceof Timestamp ? t.toDate().toISOString() : null);
const num = (v: unknown) => (typeof v === 'number' ? v : 0);

interface UserInfo {
  uid: string;
  email: string | null;
  name: string | null;
  role: Role;
  status: string;
  tierId: QuotaTierId;
  departmentId: string | null;
  departmentPath: string[];
}

function userInfo(snap: DocumentSnapshot): UserInfo {
  const d = snap.data() ?? {};
  const tier = QUOTA_TIER_IDS.includes(d.quotaTierId) ? (d.quotaTierId as QuotaTierId) : 'standard';
  return {
    uid: snap.id,
    email: d.email ?? null,
    name: d.name ?? null,
    role: d.role ?? 'user',
    status: d.status ?? 'pending',
    tierId: tier,
    departmentId: d.departmentId ?? null,
    departmentPath: d.departmentPath ?? [],
  };
}

function periodDoc(
  snap: DocumentSnapshot | null,
  user: UserInfo,
  period: string,
  tier: QuotaTier,
): QuotaPeriodDoc {
  const d = snap?.exists ? (snap.data() ?? {}) : null;
  return {
    uid: user.uid,
    period,
    tierId: d?.tierId ?? user.tierId,
    limit: d ? num(d.limit) : tier.monthlyBudget,
    premiumLimit: d ? num(d.premiumLimit) : tier.premiumBudget,
    used: num(d?.used),
    premiumUsed: num(d?.premiumUsed),
    reserved: num(d?.reserved),
    premiumReserved: num(d?.premiumReserved),
    departmentId: user.departmentId,
    departmentPath: user.departmentPath,
  };
}

export function summarize(
  doc: QuotaPeriodDoc,
  user: Pick<UserInfo, 'email' | 'name'>,
): QuotaSummary {
  const remaining = doc.limit - doc.used - doc.reserved;
  return {
    ...doc,
    email: user.email,
    name: user.name,
    remaining,
    premiumRemaining: doc.premiumLimit - doc.premiumUsed - doc.premiumReserved,
    percentUsed:
      doc.limit > 0 ? Math.round((doc.used / doc.limit) * 1000) / 10 : doc.used > 0 ? 100 : 0,
  };
}

function toAdjustment(snap: DocumentSnapshot): QuotaAdjustment {
  const d = snap.data() ?? {};
  return {
    id: snap.id,
    uid: d.uid,
    period: d.period,
    type: d.type,
    kind: d.kind,
    amount: d.amount,
    delta: d.delta,
    reason: d.reason,
    approvedBy: d.approvedBy,
    createdBy: d.createdBy,
    createdAt: iso(d.createdAt) ?? new Date(0).toISOString(),
    expiresAt: iso(d.expiresAt),
    revertedAt: iso(d.revertedAt),
  };
}

/**
 * The only way AI spending touches quotas (spec 8.7). Every request writes just the user's
 * own quotaPeriods/{uid}_{YYYYMM} document, inside a transaction: reserve the worst case
 * before calling the provider, settle the real cost afterwards. Unit and university totals
 * are never written per request; they come from the ledger (aggregation job, M8).
 */
export class QuotaService {
  constructor(private readonly db: Firestore) {}

  private periods() {
    return this.db.collection(COLLECTIONS.quotaPeriods);
  }
  private ledger() {
    return this.db.collection(COLLECTIONS.usageTransactions);
  }
  private periodRef(uid: string, period: string): DocumentReference {
    return this.periods().doc(`${uid}_${period}`);
  }

  // --- tiers ----------------------------------------------------------------------------

  async tiers(): Promise<Record<QuotaTierId, QuotaTier>> {
    const snap = await this.db.collection(COLLECTIONS.quotaTiers).get();
    const out = { ...DEFAULT_QUOTA_TIERS };
    for (const doc of snap.docs) {
      const id = doc.id as QuotaTierId;
      if (!QUOTA_TIER_IDS.includes(id)) continue;
      const d = doc.data();
      out[id] = {
        ...DEFAULT_QUOTA_TIERS[id],
        ...(typeof d.monthlyBudget === 'number' ? { monthlyBudget: d.monthlyBudget } : {}),
        ...(typeof d.premiumBudget === 'number' ? { premiumBudget: d.premiumBudget } : {}),
        ...(typeof d.requestsPerMinute === 'number'
          ? { requestsPerMinute: d.requestsPerMinute }
          : {}),
      };
    }
    return out;
  }

  /** Changes apply to periods opened afterwards (next month, or users without a period yet). */
  async updateTier(id: QuotaTierId, patch: UpdateQuotaTierRequest, by: string): Promise<QuotaTier> {
    await this.db
      .collection(COLLECTIONS.quotaTiers)
      .doc(id)
      .set({ ...patch, updatedBy: by, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return (await this.tiers())[id];
  }

  // --- request path ---------------------------------------------------------------------

  async reserve(input: ReserveInput): Promise<Reservation> {
    const now = input.now ?? new Date();
    const period = quotaPeriodOf(now);
    const tiers = await this.tiers();
    const ref = this.periodRef(input.uid, period);
    const userRef = this.db.collection(COLLECTIONS.users).doc(input.uid);
    const txnRef = this.ledger().doc();

    await this.db.runTransaction(async (tx) => {
      const [userSnap, snap] = await Promise.all([tx.get(userRef), tx.get(ref)]);
      if (!userSnap.exists) throw new QuotaError('Không tìm thấy hồ sơ người dùng.', 'not_found');
      const user = userInfo(userSnap);
      const tier = tiers[user.tierId];
      const q = periodDoc(snap, user, period, tier);

      const remaining = q.limit - q.used - q.reserved;
      if (input.estimate > remaining) {
        throw new QuotaError(
          remaining <= 0
            ? `Bạn đã dùng hết định mức AI tháng này (${formatUsd(q.limit)}). Liên hệ quản trị đơn vị để được cấp thêm.`
            : `Định mức còn lại (${formatUsd(remaining)}) không đủ cho yêu cầu này. Hãy rút ngắn câu hỏi, chọn model rẻ hơn hoặc liên hệ quản trị đơn vị.`,
          'quota_exceeded',
        );
      }
      if (input.premium && q.premiumLimit - q.premiumUsed - q.premiumReserved < input.estimate) {
        throw new QuotaError(
          'Bạn đã dùng hết hạn mức model cao cấp tháng này. Hãy dùng chế độ AUTO.',
          'premium_exceeded',
        );
      }

      const d = snap.exists ? (snap.data() ?? {}) : {};
      let windowStart = num(d.rateWindowStart);
      let count = num(d.rateCount);
      if (now.getTime() - windowStart >= WINDOW_MS) {
        windowStart = now.getTime();
        count = 0;
      }
      if (count >= tier.requestsPerMinute) {
        const wait = Math.max(1, Math.ceil((windowStart + WINDOW_MS - now.getTime()) / 1000));
        throw new QuotaError(
          `Bạn gửi quá nhanh (tối đa ${tier.requestsPerMinute} yêu cầu/phút). Vui lòng chờ ${wait} giây.`,
          'rate_limited',
          wait,
        );
      }

      tx.set(
        ref,
        {
          ...q,
          reserved: q.reserved + input.estimate,
          premiumReserved: q.premiumReserved + (input.premium ? input.estimate : 0),
          rateWindowStart: windowStart,
          rateCount: count + 1,
          updatedAt: FieldValue.serverTimestamp(),
          ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
        },
        { merge: true },
      );
      tx.create(txnRef, {
        status: 'reserved',
        uid: input.uid,
        period,
        departmentId: user.departmentId,
        departmentPath: user.departmentPath,
        appClientId: null,
        providerId: input.providerId,
        transport: input.transport,
        modelId: input.modelId,
        apiModelId: input.apiModelId,
        priceId: input.priceId,
        premium: input.premium,
        reservedCost: input.estimate,
        conversationId: input.conversationId,
        messageId: null,
        routeReason: input.routeReason,
        fallbackFrom: input.fallbackFrom ?? null,
        requestTime: Timestamp.fromDate(now),
      });
    });
    return {
      txnId: txnRef.id,
      uid: input.uid,
      period,
      estimate: input.estimate,
      premium: input.premium,
    };
  }

  /** Settles the real cost and returns the reservation; also after the sweeper expired it. */
  async commit(r: Reservation, result: CommitInput): Promise<QuotaPeriodDoc | null> {
    const ref = this.periodRef(r.uid, r.period);
    const txnRef = this.ledger().doc(r.txnId);
    return this.db.runTransaction(async (tx) => {
      const [txn, snap] = await Promise.all([tx.get(txnRef), tx.get(ref)]);
      const status = txn.get('status') as string | undefined;
      if (status === 'committed') return null; // already settled
      const stillReserved = status === 'reserved';
      const d = snap.data() ?? {};
      const update = {
        used: num(d.used) + result.totalCost,
        reserved: num(d.reserved) - (stillReserved ? r.estimate : 0),
        premiumUsed: num(d.premiumUsed) + (r.premium ? result.totalCost : 0),
        premiumReserved: num(d.premiumReserved) - (stillReserved && r.premium ? r.estimate : 0),
      };
      tx.update(ref, { ...update, updatedAt: FieldValue.serverTimestamp() });
      tx.update(txnRef, {
        status: 'committed',
        usage: result.usage,
        costInput: result.costInput,
        costCachedInput: result.costCachedInput,
        costOutput: result.costOutput,
        totalCost: result.totalCost,
        outcome: result.outcome,
        messageId: result.messageId,
        conversationId: result.conversationId,
        latencyMs: result.latencyMs,
        responseTime: Timestamp.fromDate(result.responseTime ?? new Date()),
        committedAt: FieldValue.serverTimestamp(),
      });
      return { ...(d as QuotaPeriodDoc), ...update };
    });
  }

  /** Gives the reservation back when nothing was billed (refused before any token). */
  async release(r: Reservation, status: 'released' | 'expired' = 'released'): Promise<void> {
    const ref = this.periodRef(r.uid, r.period);
    const txnRef = this.ledger().doc(r.txnId);
    await this.db.runTransaction(async (tx) => {
      const txn = await tx.get(txnRef);
      if (txn.get('status') !== 'reserved') return;
      tx.update(ref, {
        reserved: FieldValue.increment(-r.estimate),
        ...(r.premium ? { premiumReserved: FieldValue.increment(-r.estimate) } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(txnRef, { status, totalCost: 0, releasedAt: FieldValue.serverTimestamp() });
    });
  }

  /**
   * Reservations left behind (instance crashed mid-stream) are released after 10 minutes;
   * a late commit still records the cost. Returns how many were released.
   */
  async sweepReservations(now = new Date()): Promise<number> {
    const cutoff = Timestamp.fromMillis(now.getTime() - RESERVATION_TTL_MS);
    const stale = await this.ledger()
      .where('status', '==', 'reserved')
      .where('requestTime', '<', cutoff)
      .limit(500)
      .get();
    for (const doc of stale.docs) {
      await this.release(
        {
          txnId: doc.id,
          uid: doc.get('uid'),
          period: doc.get('period'),
          estimate: num(doc.get('reservedCost')),
          premium: doc.get('premium') === true,
        },
        'expired',
      );
    }
    return stale.size;
  }

  // --- views ----------------------------------------------------------------------------

  async summary(uid: string, period = quotaPeriodOf(new Date())): Promise<QuotaSummary | null> {
    const [userSnap, snap, tiers] = await Promise.all([
      this.db.collection(COLLECTIONS.users).doc(uid).get(),
      this.periodRef(uid, period).get(),
      this.tiers(),
    ]);
    if (!userSnap.exists) return null;
    const user = userInfo(userSnap);
    return summarize(periodDoc(snap, user, period, tiers[user.tierId]), user);
  }

  /** Active users (optionally inside a department subtree) with their period figures. */
  async list(period: string, withinDepartment?: string): Promise<QuotaSummary[]> {
    const usersQuery = withinDepartment
      ? this.db
          .collection(COLLECTIONS.users)
          .where('departmentPath', 'array-contains', withinDepartment)
      : this.db.collection(COLLECTIONS.users);
    const [users, tiers] = await Promise.all([usersQuery.get(), this.tiers()]);
    const active = users.docs.map(userInfo).filter((u) => u.status === 'active');
    if (active.length === 0) return [];
    const snaps = await this.db.getAll(...active.map((u) => this.periodRef(u.uid, period)));
    return active
      .map((u, i) => summarize(periodDoc(snaps[i] ?? null, u, period, tiers[u.tierId]), u))
      .sort((a, b) => b.used - a.used);
  }

  /**
   * Σ monthly limits of the active staff in a department subtree for a period: their period
   * document when it exists, else their tier's default (what they would receive).
   */
  private async allocated(
    tx: Transaction,
    departmentId: string,
    period: string,
    tiers: Record<QuotaTierId, QuotaTier>,
  ) {
    const users = await tx.get(
      this.db.collection(COLLECTIONS.users).where('departmentPath', 'array-contains', departmentId),
    );
    const active = users.docs.map(userInfo).filter((u) => u.status === 'active');
    if (active.length === 0) return { total: 0, byUid: new Map<string, number>() };
    const snaps = await tx.getAll(...active.map((u) => this.periodRef(u.uid, period)));
    const byUid = new Map<string, number>();
    active.forEach((u, i) =>
      byUid.set(u.uid, periodDoc(snaps[i] ?? null, u, period, tiers[u.tierId]).limit),
    );
    let total = 0;
    for (const v of byUid.values()) total += v;
    return { total, byUid };
  }

  // --- adjustments ----------------------------------------------------------------------

  /**
   * Changes one user's limit for the current period, with reason and approver. Increases may
   * not push any unit (with a budget) over its budget: Σ user limits ≤ unit budget.
   */
  async adjust(
    input: QuotaAdjustmentRequest,
    actor: QuotaActor,
    now = new Date(),
  ): Promise<QuotaAdjustment> {
    const period = quotaPeriodOf(now);
    const tiers = await this.tiers();
    const userRef = this.db.collection(COLLECTIONS.users).doc(input.uid);
    const ref = this.periodRef(input.uid, period);
    const adjRef = this.db.collection(COLLECTIONS.quotaAdjustments).doc();
    if (input.expiresAt && Date.parse(input.expiresAt) <= now.getTime()) {
      throw new QuotaError('Ngày hết hạn phải ở tương lai.', 'invalid');
    }

    await this.db.runTransaction(async (tx) => {
      const [userSnap, snap] = await Promise.all([tx.get(userRef), tx.get(ref)]);
      if (!userSnap.exists) throw new QuotaError('Không tìm thấy người dùng.', 'not_found');
      const user = userInfo(userSnap);
      if (actor.role === 'unit_admin') {
        const inScope =
          actor.scopeDepartmentId && user.departmentPath.includes(actor.scopeDepartmentId);
        if (!inScope || user.role !== 'user') {
          throw new QuotaError(
            'Bạn chỉ điều chỉnh định mức của người dùng trong đơn vị mình.',
            'forbidden',
          );
        }
      }
      const q = periodDoc(snap, user, period, tiers[user.tierId]);
      const field = input.kind === 'premium' ? 'premiumLimit' : 'limit';
      const current = q[field];
      const next =
        input.type === 'increase'
          ? current + input.amount
          : input.type === 'decrease'
            ? Math.max(0, current - input.amount)
            : input.amount;
      const delta = next - current;

      // Budget ceilings only concern the monthly limit (premium is a sub-limit of it).
      if (field === 'limit' && delta > 0) {
        const budgetRefs = user.departmentPath.map((d) => this.budgetRef(d, period));
        const budgets = budgetRefs.length ? await tx.getAll(...budgetRefs) : [];
        for (const b of budgets) {
          if (!b.exists) continue;
          const deptId = b.get('departmentId') as string;
          const { total } = await this.allocated(tx, deptId, period, tiers);
          if (total + delta > num(b.get('budget'))) {
            throw new QuotaError(
              `Không thể tăng: tổng định mức của đơn vị ${deptId} sẽ vượt ngân sách ` +
                `(${formatUsd(total + delta)} > ${formatUsd(num(b.get('budget')))}).`,
              'invalid',
            );
          }
        }
      }
      if (field === 'premiumLimit' && next > q.limit) {
        throw new QuotaError('Hạn mức cao cấp không được lớn hơn ngân sách tháng.', 'invalid');
      }

      tx.set(
        ref,
        {
          ...q,
          [field]: next,
          updatedAt: FieldValue.serverTimestamp(),
          ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
        },
        { merge: true },
      );
      tx.create(adjRef, {
        uid: input.uid,
        period,
        type: input.type,
        kind: input.kind,
        amount: input.amount,
        delta,
        reason: input.reason,
        approvedBy: input.approvedBy,
        createdBy: actor.uid,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: input.expiresAt ? Timestamp.fromDate(new Date(input.expiresAt)) : null,
        revertedAt: null,
      });
    });
    return toAdjustment(await adjRef.get());
  }

  async listAdjustments(
    filter: { uid?: string; period?: string },
    limit = 200,
  ): Promise<QuotaAdjustment[]> {
    let query = this.db.collection(COLLECTIONS.quotaAdjustments) as Query;
    if (filter.uid) query = query.where('uid', '==', filter.uid);
    if (filter.period) query = query.where('period', '==', filter.period);
    const snap = await query.get();
    return snap.docs
      .map(toAdjustment)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  /** Reverts temporary grants whose time is up. Returns how many were reverted. */
  async expireAdjustments(now = new Date()): Promise<number> {
    const due = await this.db
      .collection(COLLECTIONS.quotaAdjustments)
      .where('revertedAt', '==', null)
      .where('expiresAt', '<=', Timestamp.fromDate(now))
      .limit(500)
      .get();
    for (const doc of due.docs) {
      const ref = this.periodRef(doc.get('uid'), doc.get('period'));
      const field = doc.get('kind') === 'premium' ? 'premiumLimit' : 'limit';
      await this.db.runTransaction(async (tx) => {
        const [adj, period] = await Promise.all([tx.get(doc.ref), tx.get(ref)]);
        if (adj.get('revertedAt') !== null || !period.exists) return;
        tx.update(ref, { [field]: Math.max(0, num(period.get(field)) - num(adj.get('delta'))) });
        tx.update(doc.ref, { revertedAt: FieldValue.serverTimestamp() });
      });
    }
    return due.size;
  }

  /** Opens the period for every active user (Scheduler, 1st of the month). Idempotent. */
  async rollover(now = new Date()): Promise<{ period: string; created: number }> {
    const period = quotaPeriodOf(now);
    const [users, tiers] = await Promise.all([
      this.db.collection(COLLECTIONS.users).where('status', '==', 'active').get(),
      this.tiers(),
    ]);
    let created = 0;
    for (const userSnap of users.docs) {
      const user = userInfo(userSnap);
      const ref = this.periodRef(user.uid, period);
      try {
        await ref.create({
          ...periodDoc(null, user, period, tiers[user.tierId]),
          rateWindowStart: 0,
          rateCount: 0,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        created += 1;
      } catch (err) {
        if ((err as { code?: number }).code !== 6) throw err; // 6 = ALREADY_EXISTS
      }
    }
    return { period, created };
  }

  // --- budgets --------------------------------------------------------------------------

  private budgetRef(departmentId: string, period: string) {
    return this.db.collection(COLLECTIONS.budgetPeriods).doc(`${departmentId}_${period}`);
  }

  async listBudgets(period: string): Promise<Budget[]> {
    const [snap, tiers] = await Promise.all([
      this.db.collection(COLLECTIONS.budgetPeriods).where('period', '==', period).get(),
      this.tiers(),
    ]);
    const out: Budget[] = [];
    for (const doc of snap.docs) {
      const d = doc.data();
      const allocated = await this.db.runTransaction((tx) =>
        this.allocated(tx, d.departmentId, period, tiers),
      );
      out.push({
        departmentId: d.departmentId,
        period,
        budget: num(d.budget),
        allocated: allocated.total,
        usedAggregate: num(d.usedAggregate),
        aggregatedAt: iso(d.aggregatedAt),
        updatedBy: d.updatedBy ?? null,
        updatedAt: iso(d.updatedAt),
      });
    }
    return out.sort((a, b) => a.departmentId.localeCompare(b.departmentId));
  }

  /**
   * Sets a unit budget for a period. Keeps the hierarchy consistent: not below what is already
   * allocated to the unit's staff, not below its sub-units' budgets, and the unit plus its
   * siblings within the parent's budget.
   */
  async setBudget(
    department: { id: string; parentId: string | null; path: string[] },
    period: string,
    budget: number,
    actor: QuotaActor,
  ): Promise<void> {
    if (actor.role === 'unit_admin') {
      const scope = actor.scopeDepartmentId;
      if (!scope || department.id === scope || !department.path.includes(scope)) {
        throw new QuotaError(
          'Bạn chỉ phân bổ ngân sách cho các đơn vị con trong đơn vị mình.',
          'forbidden',
        );
      }
    }
    const tiers = await this.tiers();
    const ref = this.budgetRef(department.id, period);
    await this.db.runTransaction(async (tx) => {
      const all = await tx.get(
        this.db.collection(COLLECTIONS.budgetPeriods).where('period', '==', period),
      );
      const budgets = all.docs.map((d) => ({
        id: d.get('departmentId') as string,
        budget: num(d.get('budget')),
        parentId: (d.get('parentId') as string | null) ?? null,
      }));
      const children = budgets.filter((b) => b.parentId === department.id);
      const childSum = children.reduce((s, b) => s + b.budget, 0);
      if (budget < childSum) {
        throw new QuotaError(
          `Ngân sách thấp hơn tổng ngân sách các đơn vị con (${formatUsd(childSum)}).`,
          'invalid',
        );
      }
      if (department.parentId) {
        const parent = budgets.find((b) => b.id === department.parentId);
        if (parent) {
          const siblings = budgets
            .filter((b) => b.parentId === department.parentId && b.id !== department.id)
            .reduce((s, b) => s + b.budget, 0);
          if (siblings + budget > parent.budget) {
            throw new QuotaError(
              `Vượt ngân sách của đơn vị cha ${department.parentId}: còn ${formatUsd(Math.max(0, parent.budget - siblings))}.`,
              'invalid',
            );
          }
        }
      }
      const { total } = await this.allocated(tx, department.id, period, tiers);
      if (budget < total) {
        throw new QuotaError(
          `Ngân sách thấp hơn tổng định mức đã cấp cho cán bộ của đơn vị (${formatUsd(total)}).`,
          'invalid',
        );
      }
      tx.set(
        ref,
        {
          departmentId: department.id,
          parentId: department.parentId,
          period,
          budget,
          updatedBy: actor.uid,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
  }
}
