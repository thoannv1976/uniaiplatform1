import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase-admin/firestore';
import {
  APP_KEY_PATTERN,
  APP_KEY_PREFIX,
  APP_SCOPES,
  type AppClient,
  type AppScope,
  type CreateAppClientRequest,
  type UpdateAppClientRequest,
} from '@uniai/shared';
import { COLLECTIONS } from './collections.js';
import { QuotaError, QuotaService } from './quota.js';

/** lastUsedAt is refreshed at most this often (it is informational). */
const TOUCH_MS = 5 * 60_000;

const iso = (t: unknown) => (t instanceof Timestamp ? t.toDate().toISOString() : null);
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export interface VerifiedApp {
  client: AppClient;
  departmentPath: string[];
}

function toClient(snap: DocumentSnapshot): AppClient {
  const d = snap.data() ?? {};
  return {
    id: snap.id,
    name: d.name ?? '',
    description: d.description ?? '',
    ownerDepartmentId: d.ownerDepartmentId ?? '',
    scopes: ((d.scopes as string[] | undefined) ?? []).filter((s): s is AppScope =>
      (APP_SCOPES as readonly string[]).includes(s),
    ),
    monthlyBudget: typeof d.monthlyBudget === 'number' ? d.monthlyBudget : 0,
    requestsPerMinute: typeof d.requestsPerMinute === 'number' ? d.requestsPerMinute : 60,
    allowAdvanced: d.allowAdvanced === true,
    status: d.status === 'active' ? 'active' : 'disabled',
    keyLast4: d.keyLast4 ?? '',
    createdBy: d.createdBy ?? '',
    createdAt: iso(d.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(d.updatedAt) ?? new Date(0).toISOString(),
    rotatedAt: iso(d.rotatedAt),
    lastUsedAt: iso(d.lastUsedAt),
  };
}

/** A new key for `clientId`: "uak_<clientId>_<43 base64url characters>" (256 random bits). */
function newKey(clientId: string): { key: string; hash: string; last4: string } {
  const key = `${APP_KEY_PREFIX}${clientId}_${randomBytes(32).toString('base64url')}`;
  return { key, hash: sha256(key).toString('hex'), last4: key.slice(-4) };
}

/**
 * appClients/{id} (spec 9, M17): internal applications calling the Platform API. Only the
 * SHA-256 hash of a key is stored (keys carry 256 random bits, so a fast hash is enough);
 * the key itself is shown once, when it is created or rotated.
 */
export class AppClientStore {
  private readonly quota: QuotaService;

  constructor(private readonly db: Firestore) {
    this.quota = new QuotaService(db);
  }

  private col() {
    return this.db.collection(COLLECTIONS.appClients);
  }

  async list(): Promise<AppClient[]> {
    const snap = await this.col().get();
    return snap.docs.map(toClient).sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<AppClient | null> {
    if (!/^[A-Za-z0-9]{1,64}$/.test(id)) return null;
    const snap = await this.col().doc(id).get();
    return snap.exists ? toClient(snap) : null;
  }

  async create(
    input: CreateAppClientRequest,
    department: { id: string; path: string[] },
    by: string,
  ): Promise<{ client: AppClient; key: string }> {
    const ref = this.col().doc();
    const { key, hash, last4 } = newKey(ref.id);
    await this.db.runTransaction(async (tx) => {
      await this.quota.assertAppBudgetFits(tx, {
        clientId: null,
        departmentPath: department.path,
        budget: input.monthlyBudget,
      });
      tx.create(ref, {
        name: input.name,
        description: input.description,
        ownerDepartmentId: department.id,
        ownerDepartmentPath: department.path,
        scopes: input.scopes,
        monthlyBudget: input.monthlyBudget,
        requestsPerMinute: input.requestsPerMinute,
        allowAdvanced: input.allowAdvanced,
        status: 'active',
        keyHash: hash,
        keyLast4: last4,
        createdBy: by,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        rotatedAt: null,
        lastUsedAt: null,
      });
    });
    return { client: (await this.get(ref.id))!, key };
  }

  async update(id: string, patch: UpdateAppClientRequest, by: string): Promise<AppClient> {
    const ref = this.col().doc(id);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new QuotaError('Không tìm thấy ứng dụng.', 'not_found');
      const current = toClient(snap);
      const budget = patch.monthlyBudget ?? current.monthlyBudget;
      const active = (patch.status ?? current.status) === 'active';
      if (active && (budget > current.monthlyBudget || current.status !== 'active')) {
        await this.quota.assertAppBudgetFits(tx, {
          clientId: current.status === 'active' ? id : null,
          departmentPath: (snap.get('ownerDepartmentPath') as string[] | undefined) ?? [],
          budget,
        });
      }
      tx.update(ref, { ...patch, updatedBy: by, updatedAt: FieldValue.serverTimestamp() });
    });
    return (await this.get(id))!;
  }

  /** Replaces the key: the old one stops working at once. */
  async rotate(id: string, by: string): Promise<{ client: AppClient; key: string }> {
    const ref = this.col().doc(id);
    const { key, hash, last4 } = newKey(id);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new QuotaError('Không tìm thấy ứng dụng.', 'not_found');
      tx.update(ref, {
        keyHash: hash,
        keyLast4: last4,
        rotatedAt: FieldValue.serverTimestamp(),
        updatedBy: by,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    return { client: (await this.get(id))!, key };
  }

  /**
   * The application a key belongs to, or null (unknown, malformed or wrong key). Disabled
   * apps are returned so the caller can say so; comparison is constant-time.
   */
  async verify(key: string, now = new Date()): Promise<VerifiedApp | null> {
    const m = APP_KEY_PATTERN.exec(key);
    if (!m) return null;
    const snap = await this.col().doc(m[1]!).get();
    if (!snap.exists) return null;
    const stored = Buffer.from((snap.get('keyHash') as string | undefined) ?? '', 'hex');
    const given = sha256(key);
    if (stored.length !== given.length || !timingSafeEqual(stored, given)) return null;
    const lastUsed = snap.get('lastUsedAt');
    if (!(lastUsed instanceof Timestamp) || now.getTime() - lastUsed.toMillis() > TOUCH_MS) {
      void snap.ref.update({ lastUsedAt: Timestamp.fromDate(now) }).catch(() => undefined);
    }
    return {
      client: toClient(snap),
      departmentPath: (snap.get('ownerDepartmentPath') as string[] | undefined) ?? [],
    };
  }
}
