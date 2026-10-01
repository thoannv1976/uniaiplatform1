import { parseCsv, parseDepartmentRows, parseDirectoryRows, USER_CSV_COLUMNS } from '@uniai/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from './admin.js';
import { DepartmentError, DepartmentStore } from './departments.js';
import { seed } from './seed.js';
import { clearFirestoreEmulator } from './testing.js';
import { DirectoryError, UserStore, type DirectoryActor } from './users.js';

const db = getDb();
const departments = new DepartmentStore(db);
const users = new UserStore(db);
const superAdmin: DirectoryActor = { uid: 'sa', role: 'super_admin', scopeDepartmentId: null };
const ktqtAdmin: DirectoryActor = { uid: 'ka', role: 'unit_admin', scopeDepartmentId: 'KTQT' };
const ftu = (e: string) => e.endsWith('@ftu.edu.vn');

async function importUsers(csv: string, actor: DirectoryActor, dryRun = false) {
  const parsed = parseCsv(csv);
  const { rows, issues } = parseDirectoryRows(parsed, ftu);
  return users.importDirectory(rows, issues, {
    dryRun,
    actor,
    departments: await departments.map(),
    total: parsed.rows.length,
  });
}

const header = USER_CSV_COLUMNS.join(',');

beforeEach(async () => {
  await clearFirestoreEmulator();
  await seed(db);
});

describe('DepartmentStore', () => {
  it('creates children with their ancestor path and refuses a second root', async () => {
    const d = await departments.create(
      { id: 'KTQT-TMQT', name: 'Bộ môn TMQT', type: 'division', parentId: 'KTQT' },
      'sa',
    );
    expect(d.path).toEqual(['FTU', 'KTQT', 'KTQT-TMQT']);
    await expect(
      departments.create({ id: 'X', name: 'X', type: 'university', parentId: null }, 'sa'),
    ).rejects.toThrow(/đơn vị gốc/);
    await expect(
      departments.create({ id: 'KTQT', name: 'dup', type: 'faculty', parentId: 'FTU' }, 'sa'),
    ).rejects.toThrow(/đã tồn tại/);
  });

  it('moves a subtree and updates members’ paths; refuses cycles', async () => {
    await users.upsertDirectory({
      email: 'gv@ftu.edu.vn',
      role: 'user',
      status: 'active',
      departmentId: 'KTQT-KTVM',
      scopeDepartmentId: null,
      updatedBy: 't',
    });
    await departments.update('KTQT-KTVM', { parentId: 'QTKD' }, 'sa');
    expect((await departments.get('KTQT-KTVM'))?.path).toEqual(['FTU', 'QTKD', 'KTQT-KTVM']);
    expect((await users.getEntry('gv@ftu.edu.vn'))?.departmentPath).toEqual([
      'FTU',
      'QTKD',
      'KTQT-KTVM',
    ]);

    await expect(departments.update('KTQT', { parentId: 'KTQT' }, 'sa')).rejects.toThrow(
      /chính nó/,
    );
    await expect(departments.update('FTU', { parentId: 'KTQT' }, 'sa')).rejects.toBeInstanceOf(
      DepartmentError,
    );
  });

  it('refuses to archive a department that still has children or staff', async () => {
    await expect(departments.update('KTQT', { status: 'archived' }, 'sa')).rejects.toThrow(
      /đơn vị con/,
    );
    await users.upsertDirectory({
      email: 'x@ftu.edu.vn',
      role: 'user',
      status: 'active',
      departmentId: 'QLDT',
      scopeDepartmentId: null,
      updatedBy: 't',
    });
    await expect(departments.update('QLDT', { status: 'archived' }, 'sa')).rejects.toThrow(
      /còn cán bộ/,
    );
    await departments.update('QTKD', { status: 'archived' }, 'sa');
    expect((await departments.get('QTKD'))?.status).toBe('archived');
  });

  it('imports a tree in any row order, all-or-nothing', async () => {
    const csv =
      'ma_don_vi,ten_don_vi,loai,ma_don_vi_cha\nBM-A,Bộ môn A,bo_mon,K-MOI\nK-MOI,Khoa Mới,khoa,FTU\nKTQT,Khoa KTQT (đổi tên),khoa,FTU';
    const parsed = parseCsv(csv);
    const { rows, issues } = parseDepartmentRows(parsed);
    const preview = await departments.importRows(rows, issues, {
      dryRun: true,
      by: 'sa',
      total: parsed.rows.length,
    });
    expect(preview).toMatchObject({
      applied: false,
      created: 2,
      updated: 1,
      unchanged: 0,
      issues: [],
    });
    expect(await departments.get('K-MOI')).toBeNull();

    const applied = await departments.importRows(rows, [], {
      dryRun: false,
      by: 'sa',
      total: parsed.rows.length,
    });
    expect(applied.applied).toBe(true);
    expect((await departments.get('BM-A'))?.path).toEqual(['FTU', 'K-MOI', 'BM-A']);
  });

  it('reports unknown parents, cycles and extra roots by line and writes nothing', async () => {
    const csv =
      'ma_don_vi,ten_don_vi,loai,ma_don_vi_cha\nA,A,khoa,B\nB,B,khoa,A\nC,C,khoa,KHONG-CO\nR2,Trường 2,truong,';
    const parsed = parseCsv(csv);
    const { rows, issues } = parseDepartmentRows(parsed);
    const result = await departments.importRows(rows, issues, {
      dryRun: false,
      by: 'sa',
      total: parsed.rows.length,
    });
    expect(result.applied).toBe(false);
    expect(result.issues.map((i) => i.line).sort()).toEqual([2, 3, 4, 5]);
    expect(await departments.get('C')).toBeNull();
  });
});

describe('UserStore directory', () => {
  it('imports staff, links signed-in users, and is idempotent', async () => {
    await users.provision({ uid: 'u-gv2', email: 'gv2@ftu.edu.vn', name: null }); // pending, signed in earlier
    const csv = `${header}\ngv1@ftu.edu.vn,Nguyễn Văn A,CB1,KTQT-KTVM,Giảng viên,,,,\ngv2@ftu.edu.vn,Trần B,CB2,QLDT,Chuyên viên,,power,,`;
    const first = await importUsers(csv, superAdmin);
    expect(first).toMatchObject({ applied: true, created: 2, updated: 0, issues: [] });
    expect(await users.get('u-gv2')).toMatchObject({
      status: 'active',
      departmentId: 'QLDT',
      name: 'Trần B',
    });
    expect((await users.getEntry('gv2@ftu.edu.vn'))?.uid).toBe('u-gv2');
    expect((await users.getEntry('gv1@ftu.edu.vn'))?.departmentPath).toEqual([
      'FTU',
      'KTQT',
      'KTQT-KTVM',
    ]);

    const again = await importUsers(csv, superAdmin);
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
  });

  it('rejects unknown departments and writes nothing when any row is wrong', async () => {
    const csv = `${header}\nok@ftu.edu.vn,,,KTQT,,,,,\nbad@ftu.edu.vn,,,KHONG-CO,,,,,`;
    const result = await importUsers(csv, superAdmin);
    expect(result.applied).toBe(false);
    expect(result.issues).toEqual([
      { line: 3, column: 'ma_don_vi', message: expect.stringContaining('KHONG-CO') },
    ]);
    expect(await users.getEntry('ok@ftu.edu.vn')).toBeNull();
  });

  it('limits Unit Admins to plain users inside their subtree', async () => {
    await importUsers(`${header}\nboss@ftu.edu.vn,,,QTKD,,,,,`, superAdmin);
    const csv = [
      header,
      'a@ftu.edu.vn,,,KTQT-KTVM,,,,,', // ok: inside KTQT
      'b@ftu.edu.vn,,,QTKD,,,,,', // outside scope
      'c@ftu.edu.vn,,,KTQT,,auditor,,,', // role not allowed
      'boss@ftu.edu.vn,,,KTQT,,,,,', // existing person from another unit
    ].join('\n');
    const result = await importUsers(csv, ktqtAdmin);
    expect(result.applied).toBe(false);
    expect(result.issues.map((i) => i.line)).toEqual([3, 4, 5]);

    const ok = await importUsers(`${header}\na@ftu.edu.vn,,,KTQT-KTVM,,,,,`, ktqtAdmin);
    expect(ok.applied).toBe(true);
  });

  it('edits an entry with scope checks and reports which session to revoke', async () => {
    await importUsers(
      `${header}\ngv@ftu.edu.vn,,,KTQT,,,,,\nother@ftu.edu.vn,,,QTKD,,,,,`,
      superAdmin,
    );
    await users.provision({ uid: 'u-gv', email: 'gv@ftu.edu.vn', name: null });

    const locked = await users.updateEntry(
      'gv@ftu.edu.vn',
      { status: 'locked', title: 'Giảng viên chính' },
      ktqtAdmin,
    );
    expect(locked.revokeUid).toBe('u-gv');
    expect(await users.get('u-gv')).toMatchObject({ status: 'locked' });
    expect((await users.getEntry('gv@ftu.edu.vn'))?.lockedAt).toBeTruthy();

    await expect(
      users.updateEntry('other@ftu.edu.vn', { title: 'x' }, ktqtAdmin),
    ).rejects.toBeInstanceOf(DirectoryError);
    await expect(
      users.updateEntry('gv@ftu.edu.vn', { role: 'auditor' }, ktqtAdmin),
    ).rejects.toThrow(/Chỉ Quản trị hệ thống/);
    await expect(
      users.updateEntry('gv@ftu.edu.vn', { departmentId: 'QTKD' }, ktqtAdmin),
    ).rejects.toThrow(/phạm vi/);
    await expect(
      users.updateEntry('nobody@ftu.edu.vn', { title: 'x' }, superAdmin),
    ).rejects.toThrow(/Không tìm thấy/);
  });

  it('imports 1,000 rows in under 30 seconds', async () => {
    const lines = [header];
    for (let i = 0; i < 1000; i++) {
      lines.push(
        `gv${i}@ftu.edu.vn,Cán bộ ${i},CB${i},${i % 2 ? 'KTQT-KTVM' : 'QLDT'},Giảng viên,,,,`,
      );
    }
    const started = Date.now();
    const result = await importUsers(lines.join('\n'), superAdmin);
    const seconds = (Date.now() - started) / 1000;
    expect(result).toMatchObject({ applied: true, created: 1000, issues: [] });
    expect(seconds).toBeLessThan(30);
    expect((await users.listDirectory({ withinDepartment: 'KTQT' })).length).toBe(500);
  }, 60_000);
});
