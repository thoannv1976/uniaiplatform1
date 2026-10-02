import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildXlsx } from './xlsx.js';

describe('buildXlsx', () => {
  it('writes a valid package with typed cells, escaped text and safe sheet names', () => {
    const bytes = buildXlsx([
      {
        name: 'Đơn vị',
        intro: ['Báo cáo chi phí AI tháng 10/2026'],
        columns: [
          { header: 'Mã', width: 10 },
          { header: 'Chi phí (USD)', format: 'usd' },
          { header: 'Số yêu cầu', format: 'integer' },
        ],
        rows: [
          ['KTQT', 12.5, 300],
          ['<script>&"', null, 0],
          ['=HYPERLINK("x")', 1, 1],
        ],
      },
      { name: 'Model/nhà [cung] cấp: chi tiết rất dài vượt 31 ký tự', columns: [], rows: [] },
    ]);
    expect(bytes[0]).toBe(0x50); // "PK"
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    const workbook = strFromU8(files['xl/workbook.xml']!);
    expect(workbook).toContain('name="Đơn vị"');
    expect(workbook).toContain('name="Model nhà  cung  cấp  chi tiết"');
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Báo cáo');
    expect(sheet).toContain('<row r="3"><c r="A3" s="1"');
    expect(sheet).toContain('<c r="B4" s="2"><v>12.5</v></c><c r="C4" s="3"><v>300</v></c>');
    expect(sheet).toContain('&lt;script&gt;&amp;&quot;');
    // Text that looks like a formula stays text.
    expect(sheet).toContain('<t xml:space="preserve">=HYPERLINK(&quot;x&quot;)</t>');
    expect(sheet).not.toContain('<f>');
  });
});
