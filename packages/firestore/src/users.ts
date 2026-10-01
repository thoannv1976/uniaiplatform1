import {
  FieldValue,
  Timestamp,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Query,
  type Transaction,
} from 'firebase-admin/firestore';
import type {
  Department,
  DirectoryEntry,
  DirectoryImportRow,
  ImportIssue,
  ImportResult,
  QuotaTierId,
  Role,
  UpdateDirectoryRequest,
  UserProfile,
  UserStatus,
} from '@uniai/shared';
import { COLLECTIONS } from './collections.js';

/** Stored shape of users/{uid}. */
interface UserDoc {
  email: string;
  name: string | null;
  role: Role;
  status: UserStatus;
  departmentId: string | null;
  departmentPath?: string[];
  scopeDepartmentId: string | null;
  quotaTierId?: QuotaTierId;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  lastLoginAt: Timestamp | null;
}

/** Stored shape of userDirectory/{email}. Timestamps are Firestore Timestamps. */
interface StoredDirectoryEntry {
  email: string;
  uid?: string | null;
  fullName?: string | null;
  /** Legacy (M2) name field. */
  name?: string | null;
  staffCode?: string | null;
  title?: string | null;
  role: Role;
  status: UserStatus;
  departmentId: string | null;
  departmentPath?: string[];
  quotaTierId?: QuotaTierId;
  scopeDepartmentId: string | null;
  activatedAt?: Timestamp | null;
  lockedAt?: Timestamp | null;
  updatedAt?: Timestamp | null;
  updatedBy?: string | null;
}

/** Input for upsertDirectory (ops script, tests). */
export interface DirectoryGrant {
  email: string;
  name?: string | null;
  role: Role;
  status: UserStatus;
  departmentId: string | null;
  scopeDepartmentId: string | null;
  updatedBy: string;
}

export type UserPatch = Partial<
  Pick<UserDoc, 'role' | 'status' | 'departmentId' | 'scopeDepartmentId'>
>;

/** Who is changing the directory: Super Admins can do anything, Unit Admins only their subtree. */
export interface DirectoryActor {
  uid: string;
  role: Role;
  /** For unit_admin: their scope department. */
  scopeDepartmentId: string | null;
}

export class DirectoryError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'forbidden' | 'invalid',
  ) {
    super(message);
  }
}

export const normaliseEmail = (email: string) => email.trim().toLowerCase();

const iso = (t: Timestamp | null | undefined) => (t ? t.toDate().toISOString() : null);
const WRITE_BATCH = 400;

function toProfile(snap: DocumentSnapshot): UserProfile {
  const d = snap.data() as UserDoc;
  return {
    uid: snap.id,
    email: d.email,
    name: d.name ?? null,
    role: d.role,
    status: d.status,
    departmentId: d.departmentId ?? null,
    scopeDepartmentId: d.scopeDepartmentId ?? null,
    createdAt: iso(d.createdAt) ?? new Date(0).toISOString(),
    lastLoginAt: iso(d.lastLoginAt),
  };
}

function toEntry(snap: DocumentSnapshot): DirectoryEntry {
  const d = snap.data() as StoredDirectoryEntry;
  return {
    email: d.email ?? snap.id,
    uid: d.uid ?? null,
    fullName: d.fullName ?? d.name ?? null,
    staffCode: d.staffCode ?? null,
    title: d.title ?? null,
    departmentId: d.departmentId ?? null,
    departmentPath: d.departmentPath ?? [],
    role: d.role,
    status: d.status,
    quotaTierId: d.quotaTierId ?? 'standard',
    scopeDepartmentId: d.scopeDepartmentId ?? null,
    activatedAt: iso(d.activatedAt),
    lockedAt: iso(d.lockedAt),
    updatedAt: iso(d.updatedAt),
    updatedBy: d.updatedBy ?? null,
  };
}

/** Status transition timestamps written alongside a status change. */
function statusStamps(before: UserStatus | undefined, after: UserStatus) {
  if (before === after) return {};
  if (after === 'active') return { activatedAt: FieldValue.serverTimestamp() };
  if (after === 'locked') return { lockedAt: FieldValue.serverTimestamp() };
  return {};
}

/** Fields mirrored from a directory entry into users/{uid}. */
function profileFields(
  e: Pick<
    DirectoryEntry,
    'role' | 'status' | 'departmentId' | 'departmentPath' | 'scopeDepartmentId' | 'quotaTierId'
  >,
) {
  return {
    role: e.role,
    status: e.status,
    departmentId: e.departmentId,
    departmentPath: e.departmentPath,
    scopeDepartmentId: e.scopeDepartmentId,
    quotaTierId: e.quotaTierId,
  };
}

/** True when a Unit Admin with this scope may manage someone in `departmentPath`. */
export function withinScope(scope: string | null, departmentPath: string[]): boolean {
  return scope !== null && departmentPath.includes(scope);
}

export class UserStore {
  constructor(private readonly db: Firestore) {}

  private userRef(uid: string) {
    return this.db.collection(COLLECTIONS.users).doc(uid);
  }

  private directoryRef(email: string) {
    return this.db.collection(COLLECTIONS.userDirectory).doc(normaliseEmail(email));
  }

  private async departmentPath(tx: Transaction | null, id: string | null): Promise<string[]> {
    if (!id) return [];
    const ref = this.db.collection(COLLECTIONS.departments).doc(id);
    const snap = tx ? await tx.get(ref) : await ref.get();
    if (!snap.exists) throw new DirectoryError(`Không có đơn vị ${id}.`, 'invalid');
    if (snap.get('status') !== 'active')
      throw new DirectoryError(`Đơn vị ${id} đã ngừng sử dụng.`, 'invalid');
    return snap.get('path') as string[];
  }

  async get(uid: string): Promise<UserProfile | null> {
    const snap = await this.userRef(uid).get();
    return snap.exists ? toProfile(snap) : null;
  }

  /** departmentPath of a user (for scope checks); [] when unknown. */
  async departmentPathOf(uid: string): Promise<string[]> {
    const snap = await this.userRef(uid).get();
    return (snap.get('departmentPath') as string[] | undefined) ?? [];
  }

  /**
   * Returns the profile for a signed-in user, creating it on first sign-in from the
   * directory entry (or as pending when the email is not in the directory).
   */
  async provision(input: {
    uid: string;
    email: string;
    name: string | null;
  }): Promise<{ profile: UserProfile; created: boolean }> {
    const ref = this.userRef(input.uid);
    const created = await this.db.runTransaction(async (tx: Transaction) => {
      const existing = await tx.get(ref);
      if (existing.exists) return false;
      const dirRef = this.directoryRef(input.email);
      const dir = await tx.get(dirRef);
      const entry = dir.exists ? toEntry(dir) : null;
      const now = Timestamp.now();
      const doc: UserDoc = {
        email: normaliseEmail(input.email),
        name: entry?.fullName ?? input.name ?? null,
        role: entry?.role ?? 'user',
        status: entry?.status ?? 'pending',
        departmentId: entry?.departmentId ?? null,
        departmentPath: entry?.departmentPath ?? [],
        scopeDepartmentId: entry?.scopeDepartmentId ?? null,
        quotaTierId: entry?.quotaTierId ?? 'standard',
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      };
      tx.create(ref, doc);
      if (entry) tx.update(dirRef, { uid: input.uid });
      return true;
    });
    const profile = await this.get(input.uid);
    if (!profile) throw new Error(`Không tạo được hồ sơ cho ${input.uid}`);
    return { profile, created };
  }

  /** Records a sign-in and returns the previous sign-in time (null on first sign-in). */
  async touchLogin(uid: string): Promise<Date | null> {
    const ref = this.userRef(uid);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const previous = (snap.get('lastLoginAt') as Timestamp | null | undefined) ?? null;
      tx.update(ref, { lastLoginAt: FieldValue.serverTimestamp() });
      return previous ? previous.toDate() : null;
    });
  }

  /** Signed-in users (used for the pending-approval queue). */
  async list(filter: { status?: UserStatus; withinDepartment?: string; limit?: number } = {}) {
    let query = this.db.collection(COLLECTIONS.users).limit(filter.limit ?? 500);
    if (filter.withinDepartment)
      query = query.where('departmentPath', 'array-contains', filter.withinDepartment);
    const snap = await query.get();
    return snap.docs
      .map(toProfile)
      .filter((u) => !filter.status || u.status === filter.status)
      .sort((a, b) => a.email.localeCompare(b.email));
  }

  /**
   * Applies an admin change to users/{uid} and mirrors it into the directory entry so a
   * later directory import does not silently revert it.
   */
  async update(uid: string, patch: UserPatch, updatedBy: string) {
    const ref = this.userRef(uid);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const before = toProfile(snap);
      const dirRef = this.directoryRef(before.email);
      const dir = await tx.get(dirRef);
      const departmentPath =
        patch.departmentId !== undefined
          ? await this.departmentPath(tx, patch.departmentId)
          : ((snap.get('departmentPath') as string[] | undefined) ?? []);
      const after = { ...before, ...patch };
      tx.update(ref, { ...patch, departmentPath, updatedAt: FieldValue.serverTimestamp() });
      const old = dir.exists ? (dir.data() as StoredDirectoryEntry) : null;
      tx.set(dirRef, {
        ...(old ?? {}),
        email: before.email,
        uid,
        fullName: old?.fullName ?? old?.name ?? before.name,
        role: after.role,
        status: after.status,
        departmentId: after.departmentId,
        departmentPath,
        scopeDepartmentId: after.scopeDepartmentId,
        quotaTierId: old?.quotaTierId ?? 'standard',
        ...statusStamps(before.status, after.status),
        updatedBy,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { before, after };
    });
  }

  /**
   * Creates or replaces a directory grant and syncs it to an existing profile with the
   * same email (ops script, tests).
   */
  async upsertDirectory(grant: DirectoryGrant): Promise<{ syncedUid: string | null }> {
    const email = normaliseEmail(grant.email);
    const departmentPath = await this.departmentPath(null, grant.departmentId).catch(() => []);
    const existing = await this.db
      .collection(COLLECTIONS.users)
      .where('email', '==', email)
      .limit(1)
      .get();
    const userDoc = existing.docs[0];
    const dirRef = this.directoryRef(email);
    const old = await dirRef.get();
    const oldEntry = old.exists ? toEntry(old) : null;
    const entry = {
      email,
      uid: userDoc?.id ?? oldEntry?.uid ?? null,
      fullName: grant.name ?? oldEntry?.fullName ?? null,
      role: grant.role,
      status: grant.status,
      departmentId: grant.departmentId,
      departmentPath,
      scopeDepartmentId: grant.scopeDepartmentId,
      quotaTierId: oldEntry?.quotaTierId ?? ('standard' as const),
    };
    const batch = this.db.batch();
    batch.set(dirRef, {
      ...(old.data() ?? {}),
      ...entry,
      ...statusStamps(oldEntry?.status, grant.status),
      updatedBy: grant.updatedBy,
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (userDoc)
      batch.update(userDoc.ref, {
        ...profileFields(entry),
        updatedAt: FieldValue.serverTimestamp(),
      });
    await batch.commit();
    return { syncedUid: userDoc?.id ?? null };
  }

  async getEntry(email: string): Promise<DirectoryEntry | null> {
    const snap = await this.directoryRef(email).get();
    return snap.exists ? toEntry(snap) : null;
  }

  /** The staff roster. Unit Admins pass their scope to see only their subtree. */
  async listDirectory(filter: { withinDepartment?: string } = {}): Promise<DirectoryEntry[]> {
    let query: Query = this.db.collection(COLLECTIONS.userDirectory);
    if (filter.withinDepartment)
      query = query.where('departmentPath', 'array-contains', filter.withinDepartment);
    const snap = await query.get();
    return snap.docs.map(toEntry).sort((a, b) => a.email.localeCompare(b.email));
  }

  /** Throws when a Unit Admin tries to manage someone or something outside their remit. */
  private assertCanManage(
    actor: DirectoryActor,
    target: { role: Role; departmentPath: string[] } | null,
  ) {
    if (actor.role === 'super_admin') return;
    if (actor.role !== 'unit_admin')
      throw new DirectoryError('Bạn không có quyền thực hiện thao tác này.', 'forbidden');
    if (
      target &&
      (target.role !== 'user' || !withinScope(actor.scopeDepartmentId, target.departmentPath))
    ) {
      throw new DirectoryError('Cán bộ này không thuộc phạm vi đơn vị bạn quản lý.', 'forbidden');
    }
  }

  /**
   * Edits one directory entry (and the profile when the person has signed in).
   * Returns the uid whose sessions must be revoked when the entry was just locked.
   */
  async updateEntry(
    email: string,
    patch: UpdateDirectoryRequest,
    actor: DirectoryActor,
  ): Promise<{ before: DirectoryEntry; after: DirectoryEntry; revokeUid: string | null }> {
    if (
      actor.role !== 'super_admin' &&
      (patch.role !== undefined || patch.scopeDepartmentId !== undefined)
    ) {
      throw new DirectoryError(
        'Chỉ Quản trị hệ thống được thay đổi vai trò hoặc đơn vị quản lý.',
        'forbidden',
      );
    }
    const dirRef = this.directoryRef(email);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(dirRef);
      if (!snap.exists)
        throw new DirectoryError('Không tìm thấy cán bộ trong danh bạ.', 'not_found');
      const before = toEntry(snap);
      this.assertCanManage(actor, before);
      if (
        before.uid &&
        before.uid === actor.uid &&
        (patch.role !== undefined || patch.status !== undefined)
      ) {
        throw new DirectoryError(
          'Không thể tự thay đổi vai trò hoặc trạng thái của chính mình.',
          'invalid',
        );
      }
      const departmentPath =
        patch.departmentId !== undefined
          ? await this.departmentPath(tx, patch.departmentId)
          : before.departmentPath;
      if (actor.role === 'unit_admin' && !withinScope(actor.scopeDepartmentId, departmentPath)) {
        throw new DirectoryError(
          'Chỉ được chuyển cán bộ trong phạm vi đơn vị bạn quản lý.',
          'forbidden',
        );
      }
      if (patch.scopeDepartmentId) await this.departmentPath(tx, patch.scopeDepartmentId);
      const userRef = before.uid ? this.userRef(before.uid) : null;
      const userSnap = userRef ? await tx.get(userRef) : null;

      const after: DirectoryEntry = {
        ...before,
        ...patch,
        departmentPath,
        updatedBy: actor.uid,
      };
      if (after.role === 'unit_admin' && !after.scopeDepartmentId) {
        throw new DirectoryError('Quản trị đơn vị cần có đơn vị quản lý.', 'invalid');
      }
      tx.update(dirRef, {
        ...patch,
        departmentPath,
        ...statusStamps(before.status, after.status),
        updatedBy: actor.uid,
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (userRef && userSnap?.exists) {
        tx.update(userRef, {
          ...profileFields(after),
          ...(patch.fullName !== undefined ? { name: patch.fullName } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      const revokeUid = before.status !== 'locked' && after.status === 'locked' ? before.uid : null;
      return { before, after, revokeUid };
    });
  }

  /**
   * Validates and (unless dryRun) applies a staff CSV. All-or-nothing: if any row has an
   * issue nothing is written. Unit Admins may only import plain users into their subtree.
   */
  async importDirectory(
    rows: DirectoryImportRow[],
    issues: ImportIssue[],
    options: {
      dryRun: boolean;
      actor: DirectoryActor;
      departments: Map<string, Department>;
      total: number;
    },
  ): Promise<ImportResult & { revokeUids: string[] }> {
    const { actor, departments } = options;
    const existing = new Map((await this.listDirectory()).map((e) => [e.email, e]));
    const usersByEmail = new Map<string, { ref: DocumentReference; uid: string }>();
    const userSnap = await this.db.collection(COLLECTIONS.users).select('email').get();
    for (const d of userSnap.docs)
      usersByEmail.set(d.get('email') as string, { ref: d.ref, uid: d.id });

    const writes: {
      email: string;
      entry: Record<string, unknown>;
      user: DocumentReference | null;
      profile: Record<string, unknown>;
    }[] = [];
    const revokeUids: string[] = [];
    let created = 0;
    let updated = 0;

    for (const r of rows) {
      const rowIssues: ImportIssue[] = [];
      const dept = r.departmentId ? departments.get(r.departmentId) : null;
      if (r.departmentId && (!dept || dept.status !== 'active')) {
        rowIssues.push({
          line: r.line,
          column: 'ma_don_vi',
          message: `Không có đơn vị ${r.departmentId} (hoặc đã ngừng sử dụng)`,
        });
      }
      const scopeDept = r.scopeDepartmentId ? departments.get(r.scopeDepartmentId) : null;
      if (r.scopeDepartmentId && (!scopeDept || scopeDept.status !== 'active')) {
        rowIssues.push({
          line: r.line,
          column: 'don_vi_quan_ly',
          message: `Không có đơn vị ${r.scopeDepartmentId}`,
        });
      }
      const departmentPath = dept?.path ?? [];
      const old = existing.get(r.email) ?? null;
      if (actor.role !== 'super_admin') {
        if (r.role !== 'user' || r.scopeDepartmentId) {
          rowIssues.push({
            line: r.line,
            column: 'vai_tro',
            message: 'Quản trị đơn vị chỉ được nhập vai trò "user"',
          });
        }
        if (!withinScope(actor.scopeDepartmentId, departmentPath)) {
          rowIssues.push({
            line: r.line,
            column: 'ma_don_vi',
            message: 'Đơn vị nằm ngoài phạm vi bạn quản lý',
          });
        }
        if (
          old &&
          (old.role !== 'user' || !withinScope(actor.scopeDepartmentId, old.departmentPath))
        ) {
          rowIssues.push({
            line: r.line,
            column: 'email',
            message: 'Cán bộ này không thuộc phạm vi đơn vị bạn quản lý',
          });
        }
      }
      const user = usersByEmail.get(r.email) ?? null;
      if (
        user &&
        user.uid === actor.uid &&
        old &&
        (old.role !== r.role || old.status !== r.status)
      ) {
        rowIssues.push({
          line: r.line,
          column: 'vai_tro',
          message: 'Không thể tự thay đổi vai trò hoặc trạng thái của chính mình',
        });
      }
      if (rowIssues.length) {
        issues.push(...rowIssues);
        continue;
      }

      const next = {
        email: r.email,
        uid: user?.uid ?? old?.uid ?? null,
        fullName: r.fullName,
        staffCode: r.staffCode,
        title: r.title,
        departmentId: r.departmentId,
        departmentPath,
        role: r.role,
        status: r.status,
        quotaTierId: r.quotaTierId,
        scopeDepartmentId: r.scopeDepartmentId,
      };
      const same =
        old &&
        (Object.keys(next) as (keyof typeof next)[]).every(
          (k) => JSON.stringify(old[k]) === JSON.stringify(next[k]),
        );
      if (same) continue;
      if (old) updated++;
      else created++;
      if (user && old?.status !== 'locked' && r.status === 'locked') revokeUids.push(user.uid);
      writes.push({
        email: r.email,
        entry: { ...next, ...statusStamps(old?.status, r.status) },
        user: user?.ref ?? null,
        profile: { ...profileFields(next), ...(r.fullName ? { name: r.fullName } : {}) },
      });
    }

    const linesWithIssues = new Set(issues.map((i) => i.line)).size;
    const result = {
      dryRun: options.dryRun,
      applied: false,
      total: options.total,
      created,
      updated,
      unchanged: Math.max(0, options.total - created - updated - linesWithIssues),
      issues: issues.sort((a, b) => a.line - b.line),
      revokeUids: [] as string[],
    };
    if (options.dryRun || issues.length) return result;

    for (let i = 0; i < writes.length; i += WRITE_BATCH / 2) {
      const batch = this.db.batch();
      for (const w of writes.slice(i, i + WRITE_BATCH / 2)) {
        batch.set(
          this.directoryRef(w.email),
          { ...w.entry, updatedBy: actor.uid, updatedAt: FieldValue.serverTimestamp() },
          { merge: true },
        );
        if (w.user) batch.update(w.user, { ...w.profile, updatedAt: FieldValue.serverTimestamp() });
      }
      await batch.commit();
    }
    return { ...result, applied: true, revokeUids };
  }
}
