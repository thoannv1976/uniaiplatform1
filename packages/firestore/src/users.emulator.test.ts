import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from './admin.js';
import { AuditStore } from './audit.js';
import { clearFirestoreEmulator } from './testing.js';
import { seed } from './seed.js';
import { UserStore } from './users.js';

const db = getDb();
const users = new UserStore(db);

beforeEach(async () => {
  await clearFirestoreEmulator();
});

describe('UserStore.provision', () => {
  it('creates a pending user when the email is not in the directory', async () => {
    const { profile, created } = await users.provision({
      uid: 'u1',
      email: 'GV01@ftu.edu.vn',
      name: 'A',
    });
    expect(created).toBe(true);
    expect(profile).toMatchObject({ email: 'gv01@ftu.edu.vn', role: 'user', status: 'pending' });
  });

  it('takes role, status and department from the directory', async () => {
    await seed(db);
    await users.upsertDirectory({
      email: 'truongkhoa@ftu.edu.vn',
      role: 'unit_admin',
      status: 'active',
      departmentId: 'KTQT',
      scopeDepartmentId: 'KTQT',
      updatedBy: 'test',
    });
    const { profile } = await users.provision({
      uid: 'u2',
      email: 'truongkhoa@ftu.edu.vn',
      name: null,
    });
    expect(profile).toMatchObject({
      role: 'unit_admin',
      status: 'active',
      scopeDepartmentId: 'KTQT',
    });
  });

  it('is idempotent and does not overwrite an existing profile', async () => {
    await users.provision({ uid: 'u3', email: 'a@ftu.edu.vn', name: 'A' });
    await users.update('u3', { status: 'active' }, 'admin');
    const again = await users.provision({ uid: 'u3', email: 'a@ftu.edu.vn', name: 'A' });
    expect(again.created).toBe(false);
    expect(again.profile.status).toBe('active');
  });
});

describe('UserStore.update / upsertDirectory', () => {
  it('mirrors admin changes into the directory', async () => {
    await users.provision({ uid: 'u4', email: 'b@ftu.edu.vn', name: null });
    const result = await users.update('u4', { role: 'auditor', status: 'active' }, 'admin-uid');
    expect(result?.before.role).toBe('user');
    const dir = await db.collection('userDirectory').doc('b@ftu.edu.vn').get();
    expect(dir.get('role')).toBe('auditor');
    expect(dir.get('updatedBy')).toBe('admin-uid');
  });

  it('syncs a directory change to an existing profile', async () => {
    await users.provision({ uid: 'u5', email: 'c@ftu.edu.vn', name: null });
    const { syncedUid } = await users.upsertDirectory({
      email: 'C@ftu.edu.vn',
      role: 'super_admin',
      status: 'active',
      departmentId: null,
      scopeDepartmentId: null,
      updatedBy: 'ops',
    });
    expect(syncedUid).toBe('u5');
    expect((await users.get('u5'))?.role).toBe('super_admin');
  });

  it('returns null when updating an unknown user', async () => {
    expect(await users.update('missing', { status: 'locked' }, 'x')).toBeNull();
  });

  it('lists by status and department subtree', async () => {
    await seed(db);
    await users.provision({ uid: 'p1', email: 'p1@ftu.edu.vn', name: null });
    await users.provision({ uid: 'p2', email: 'p2@ftu.edu.vn', name: null });
    await users.update('p2', { status: 'active', departmentId: 'KTQT-KTVM' }, 'x');
    expect((await users.list({ status: 'pending' })).map((u) => u.uid)).toEqual(['p1']);
    expect((await users.list({ withinDepartment: 'KTQT' })).map((u) => u.uid)).toEqual(['p2']);
  });

  it('records the previous login time', async () => {
    await users.provision({ uid: 'l1', email: 'l1@ftu.edu.vn', name: null });
    expect(await users.touchLogin('l1')).toBeNull();
    expect(await users.touchLogin('l1')).toBeInstanceOf(Date);
  });
});

describe('AuditStore', () => {
  it('appends and lists newest first', async () => {
    const audit = new AuditStore(db);
    await audit.append({ event: 'USER_LOGIN', actor: 'u1' });
    await audit.append({
      event: 'ADMIN_CHANGE',
      actor: 'u2',
      target: 'u1',
      metadata: { role: 'auditor' },
    });
    const logs = await audit.list(10);
    expect(logs.map((l) => l.event)).toEqual(['ADMIN_CHANGE', 'USER_LOGIN']);
    expect(logs[0]?.metadata).toEqual({ role: 'auditor' });
  });
});
