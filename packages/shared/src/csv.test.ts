import { describe, expect, it } from 'vitest';
import { CsvFormatError, parseCsv, toCsv } from './csv.js';

describe('parseCsv', () => {
  it('reads Excel "CSV UTF-8" with BOM, CRLF, quotes and Vietnamese text', () => {
    const text =
      '﻿Email,Ho_ten,Chuc_vu\r\n' +
      'gv01@ftu.edu.vn,"Nguyễn Văn A","Trưởng bộ môn, Kinh tế"\r\n' +
      'gv02@ftu.edu.vn,Trần Thị B,"Giảng viên ""chính"""\r\n';
    const parsed = parseCsv(text);
    expect(parsed.headers).toEqual(['email', 'ho_ten', 'chuc_vu']);
    expect(parsed.rows).toEqual([
      {
        line: 2,
        values: {
          email: 'gv01@ftu.edu.vn',
          ho_ten: 'Nguyễn Văn A',
          chuc_vu: 'Trưởng bộ môn, Kinh tế',
        },
      },
      {
        line: 3,
        values: { email: 'gv02@ftu.edu.vn', ho_ten: 'Trần Thị B', chuc_vu: 'Giảng viên "chính"' },
      },
    ]);
  });

  it('detects ";" as delimiter and skips blank lines, keeping real line numbers', () => {
    const parsed = parseCsv('a;b\n\n1;2\n;\n3;4');
    expect(parsed.rows.map((r) => [r.line, r.values.a, r.values.b])).toEqual([
      [3, '1', '2'],
      [5, '3', '4'],
    ]);
  });

  it('keeps multi-line quoted fields and reports the starting line', () => {
    const parsed = parseCsv('a,b\n"x\ny",2\nz,3');
    expect(parsed.rows[0]?.values.a).toBe('x\ny');
    expect(parsed.rows[1]?.line).toBe(4);
  });

  it('fills missing trailing cells with empty strings', () => {
    expect(parseCsv('a,b,c\n1').rows[0]?.values).toEqual({ a: '1', b: '', c: '' });
  });

  it('rejects malformed input with Vietnamese messages', () => {
    expect(() => parseCsv('')).toThrow(CsvFormatError);
    expect(() => parseCsv('a,a\n1,2')).toThrow(/lặp lại/);
    expect(() => parseCsv('a\n"open')).toThrow(/ngoặc kép/);
    expect(() => parseCsv('a,b\n1,2,3')).toThrow(/Dòng 2 có 3 cột/);
  });
});

describe('toCsv', () => {
  it('neutralises spreadsheet formulas and restores them on import', () => {
    const csv = toCsv(
      ['name'],
      [{ name: '=HYPERLINK("http://evil","x")' }, { name: '@SUM(A1)' }, { name: '-1' }],
    );
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csv).toContain(`'@SUM(A1)`);
    expect(parseCsv(csv).rows.map((r) => r.values.name)).toEqual([
      '=HYPERLINK("http://evil","x")',
      '@SUM(A1)',
      '-1',
    ]);
  });

  it('round-trips through parseCsv', () => {
    const rows = [
      { name: 'Khoa "A", B', note: 'dòng 1\ndòng 2' },
      { name: 'C', note: null },
    ];
    const parsed = parseCsv(toCsv(['name', 'note'], rows));
    expect(parsed.rows.map((r) => r.values)).toEqual([
      { name: 'Khoa "A", B', note: 'dòng 1\ndòng 2' },
      { name: 'C', note: '' },
    ]);
  });
});
