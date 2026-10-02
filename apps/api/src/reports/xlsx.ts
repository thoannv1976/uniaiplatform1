import { strToU8, zipSync } from 'fflate';

/**
 * Minimal Office Open XML workbook writer (spec 8.13: "xuất Excel"): text and number cells,
 * a bold header row, column widths and two number formats. No formulas, no shared strings.
 */

export type CellFormat = 'usd' | 'integer' | 'percent' | 'text';
export interface Column {
  header: string;
  width?: number;
  format?: CellFormat;
}
export interface Sheet {
  name: string;
  /** Lines above the table (title, period…), written as text in column A. */
  intro?: string[];
  columns: Column[];
  rows: (string | number | null)[][];
}

const esc = (s: string) =>
  s
    // Characters XML 1.0 does not allow.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function columnName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Style ids in styles.xml: 0 normal, 1 bold, 2 USD (0.00), 3 integer (#,##0), 4 percent (0.0). */
const STYLE: Record<CellFormat, number> = { text: 0, usd: 2, integer: 3, percent: 4 };

function cell(ref: string, value: string | number | null, style: number): string {
  if (value === null || value === '') return '';
  const s = style ? ` s="${style}"` : '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  // Text never starts a formula: Excel only evaluates <f> elements.
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(String(value))}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const rows: string[] = [];
  let r = 1;
  for (const line of sheet.intro ?? []) {
    rows.push(`<row r="${r}">${cell(`A${r}`, line, r === 1 ? 1 : 0)}</row>`);
    r++;
  }
  if (sheet.intro?.length) r++;
  const headerRow = r;
  rows.push(
    `<row r="${r}">${sheet.columns.map((c, i) => cell(`${columnName(i)}${r}`, c.header, 1)).join('')}</row>`,
  );
  r++;
  for (const values of sheet.rows) {
    rows.push(
      `<row r="${r}">${values
        .map((v, i) => cell(`${columnName(i)}${r}`, v, STYLE[sheet.columns[i]?.format ?? 'text']))
        .join('')}</row>`,
    );
    r++;
  }
  const cols = sheet.columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 16}" customWidth="1"/>`)
    .join('');
  const pane = `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `${pane}<cols>${cols}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`
  );
}

/** Sheet names: ≤ 31 characters, none of []:*?/\ , unique. */
function sheetNames(sheets: Sheet[]): string[] {
  const used = new Set<string>();
  return sheets.map((s, i) => {
    let name =
      s.name
        .replace(/[[\]:*?/\\]/g, ' ')
        .slice(0, 31)
        .trim() || `Sheet${i + 1}`;
    while (used.has(name)) name = `${name.slice(0, 28)} ${i + 1}`;
    used.add(name);
    return name;
  });
}

export function buildXlsx(sheets: Sheet[]): Uint8Array {
  const names = sheetNames(sheets);
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        `</Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        names
          .map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join('') +
        `</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`,
    ),
    'xl/styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts>` +
        `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
        `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
        `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
        `<cellXfs count="5">` +
        `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
        `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
        `<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
        `<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
        `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
        `</cellXfs>` +
        `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
        `</styleSheet>`,
    ),
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s));
  });
  return zipSync(files, { level: 6 });
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
