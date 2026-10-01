import {
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';
import type { Role, UserProfile, UserStatus } from '@uniai/shared';
import { COLLECTIONS } from './collections.js';

/** Stored shape of users/{uid}. */
interface UserDoc {
  email: string;
  name: string | null;
  role: Role;
  status: UserStatus;
  departmentId: string | null;
  scopeDepartmentId: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  lastLoginAt: Timestamp | null;
}

/** Stored shape of userDirectory/{email}: what the university grants to an email address. */
export interface DirectoryEntry {
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

export const normaliseEmail = (email: string) => email.trim().toLowerCase();

const iso = (t: Timestamp | null | undefined) => (t ? t.toDate().toISOString() : null);

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

export class UserStore {
  constructor(private readonly db: Firestore) {}

  private userRef(uid: string) {
    return this.db.collection(COLLECTIONS.users).doc(uid);
  }

  private directoryRef(email: string) {
    return this.db.collection(COLLECTIONS.userDirectory).doc(normaliseEmail(email));
  }

  async get(uid: string): Promise<UserProfile | null> {
    const snap = await this.userRef(uid).get();
    return snap.exists ? toProfile(snap) : null;
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
      const dir = await tx.get(this.directoryRef(input.email));
      const entry = dir.exists ? (dir.data() as DirectoryEntry) : null;
      const now = Timestamp.now();
      const doc: UserDoc = {
        email: normaliseEmail(input.email),
        name: input.name ?? entry?.name ?? null,
        role: entry?.role ?? 'user',
        status: entry?.status ?? 'pending',
        departmentId: entry?.departmentId ?? null,
        scopeDepartmentId: entry?.scopeDepartmentId ?? null,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      };
      tx.create(ref, doc);
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

  async list(filter: { status?: UserStatus; departmentId?: string; limit?: number } = {}) {
    let query = this.db.collection(COLLECTIONS.users).limit(filter.limit ?? 200);
    if (filter.status) query = query.where('status', '==', filter.status);
    if (filter.departmentId) query = query.where('departmentId', '==', filter.departmentId);
    const snap = await query.get();
    return snap.docs.map(toProfile).sort((a, b) => a.email.localeCompare(b.email));
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
      const after = { ...before, ...patch };
      tx.update(ref, { ...patch, updatedAt: FieldValue.serverTimestamp() });
      const entry: DirectoryEntry = {
        email: before.email,
        name: before.name,
        role: after.role,
        status: after.status,
        departmentId: after.departmentId,
        scopeDepartmentId: after.scopeDepartmentId,
        updatedBy,
      };
      tx.set(dirRef, { ...(dir.data() ?? {}), ...entry, updatedAt: FieldValue.serverTimestamp() });
      return { before, after };
    });
  }

  /**
   * Creates or replaces a directory entry and syncs it to an existing profile with the
   * same email (used by the ops script and, in M3, the CSV import).
   */
  async upsertDirectory(entry: DirectoryEntry): Promise<{ syncedUid: string | null }> {
    const email = normaliseEmail(entry.email);
    const existing = await this.db
      .collection(COLLECTIONS.users)
      .where('email', '==', email)
      .limit(1)
      .get();
    const batch = this.db.batch();
    batch.set(this.directoryRef(email), {
      ...entry,
      email,
      updatedAt: FieldValue.serverTimestamp(),
    });
    const userDoc = existing.docs[0];
    if (userDoc) {
      batch.update(userDoc.ref, {
        role: entry.role,
        status: entry.status,
        departmentId: entry.departmentId,
        scopeDepartmentId: entry.scopeDepartmentId,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
    return { syncedUid: userDoc?.id ?? null };
  }
}
