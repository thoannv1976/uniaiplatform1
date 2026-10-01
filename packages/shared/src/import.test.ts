import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from './csv.js';
import { departmentToCsvRow, parseDepartmentRows } from './departments.js';
import { directoryToCsvRow, parseDirectoryRows, USER_CSV_COLUMNS } from './directory.js';

const ftu = (e: string) => e.endsWith('@ftu.edu.vn');

describe('parseDepartmentRows', () => {
  it('accepts valid rows and upper-cases codes', () => {
    const { rows, issues } = parseDepartmentRows(
      parseCsv(
        'ma_don_vi,ten_don_vi,loai,ma_don_vi_cha\nftu,Trường ĐH Ngoại thương,truong,\ncntt,Khoa CNTT,khoa,ftu',
      ),
    );
    expect(issues).toEqual([]);
    expect(rows).toEqual([
      { line: 2, id: 'FTU', name: 'Trường ĐH Ngoại thương', type: 'university', parentId: null },
      { line: 3, id: 'CNTT', name: 'Khoa CNTT', type: 'faculty', parentId: 'FTU' },
    ]);
  });

  it('reports every problem with its line and column', () => {
    const { rows, issues } = parseDepartmentRows(
      parseCsv(
        'ma_don_vi,ten_don_vi,loai,ma_don_vi_cha\nA B,X,khoa,\nK1,,vien,\nK2,Y,khoa,\nK2,Z,khoa,',
      ),
    );
    expect(rows.map((r) => r.id)).toEqual(['K2']);
    expect(issues).toEqual([
      { line: 2, column: 'ma_don_vi', message: expect.stringContaining('Mã đơn vị') },
      { line: 3, column: 'ten_don_vi', message: 'Tên đơn vị không được trống' },
      { line: 3, column: 'loai', message: expect.stringContaining('Loại phải là') },
      { line: 5, column: 'ma_don_vi', message: 'Trùng mã với dòng 4' },
    ]);
  });

  it('requires the mandatory columns', () => {
    expect(parseDepartmentRows(parseCsv('ma_don_vi\nA')).issues[0]?.message).toMatch(
      /Thiếu cột: ten_don_vi, loai/,
    );
  });

  it('exports in the import format', () => {
    const row = departmentToCsvRow({
      id: 'BM1',
      name: 'Bộ môn 1',
      type: 'division',
      parentId: 'CNTT',
      path: [],
      status: 'active',
    });
    expect(row).toEqual({
      ma_don_vi: 'BM1',
      ten_don_vi: 'Bộ môn 1',
      loai: 'bo_mon',
      ma_don_vi_cha: 'CNTT',
    });
  });
});

describe('parseDirectoryRows', () => {
  const header = USER_CSV_COLUMNS.join(',');

  it('applies defaults and normalises emails and codes', () => {
    const { rows, issues } = parseDirectoryRows(
      parseCsv(`${header}\nGV01@FTU.edu.vn,Nguyễn Văn A,CB001,cntt,Giảng viên,,,,`),
      ftu,
    );
    expect(issues).toEqual([]);
    expect(rows[0]).toEqual({
      line: 2,
      email: 'gv01@ftu.edu.vn',
      fullName: 'Nguyễn Văn A',
      staffCode: 'CB001',
      title: 'Giảng viên',
      departmentId: 'CNTT',
      role: 'user',
      quotaTierId: 'standard',
      status: 'active',
      scopeDepartmentId: null,
    });
  });

  it('rejects other domains, duplicates, bad enums and unit admins without scope', () => {
    const csv = [
      header,
      'a@gmail.com,,,,,,,,',
      'b@ftu.edu.vn,,,,,boss,,,',
      'c@ftu.edu.vn,,,,,,vip,pending,',
      'd@ftu.edu.vn,,,,,unit_admin,,,',
      'e@ftu.edu.vn,,,,,,,,',
      'E@ftu.edu.vn,,,,,,,,',
      'not-an-email,,,,,,,,',
    ].join('\n');
    const { rows, issues } = parseDirectoryRows(parseCsv(csv), ftu);
    expect(rows.map((r) => r.email)).toEqual(['e@ftu.edu.vn']);
    expect(issues.map((i) => `${i.line}:${i.column}`)).toEqual([
      '2:email',
      '3:vai_tro',
      '4:nhom_dinh_muc',
      '4:trang_thai',
      '5:don_vi_quan_ly',
      '7:email',
      '8:email',
    ]);
  });

  it('round-trips through export', () => {
    const entry = {
      email: 'gv@ftu.edu.vn',
      uid: 'u1',
      fullName: 'Lê C',
      staffCode: null,
      title: null,
      departmentId: 'KT',
      departmentPath: ['FTU', 'KT'],
      role: 'unit_admin' as const,
      status: 'locked' as const,
      quotaTierId: 'power' as const,
      scopeDepartmentId: 'KT',
      activatedAt: null,
      lockedAt: null,
      updatedAt: null,
      updatedBy: null,
    };
    const csv = toCsv([...USER_CSV_COLUMNS], [directoryToCsvRow(entry)]);
    const { rows } = parseDirectoryRows(parseCsv(csv), ftu);
    expect(rows[0]).toMatchObject({
      email: 'gv@ftu.edu.vn',
      role: 'unit_admin',
      status: 'locked',
      quotaTierId: 'power',
      scopeDepartmentId: 'KT',
    });
  });
});
