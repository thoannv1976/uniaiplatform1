/**
 * Minimal RFC 4180 CSV reader/writer for admin imports. Accepts what Excel produces with
 * "CSV UTF-8": optional BOM, CRLF or LF, quoted fields with "" escapes, and ',' or ';'
 * as the delimiter (detected from the header line).
 */
export interface CsvRow {
  /** 1-based line number in the file (header is line 1), for error messages. */
  line: number;
  values: Record<string, string>;
}

export interface ParsedCsv {
  headers: string[];
  rows: CsvRow[];
}

export class CsvFormatError extends Error {}

function detectDelimiter(firstLine: string): ',' | ';' {
  const commas = (firstLine.match(/,/g) ?? []).length;
  const semicolons = (firstLine.match(/;/g) ?? []).length;
  return semicolons > commas ? ';' : ',';
}

/** Splits text into records of raw fields, tracking the line each record starts on. */
function tokenize(text: string, delimiter: string): { line: number; fields: string[] }[] {
  const records: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      fields.push(field);
      records.push({ line: recordLine, fields });
      fields = [];
      field = '';
      line++;
      recordLine = line;
    } else {
      field += ch;
    }
  }
  if (inQuotes)
    throw new CsvFormatError(`Dấu ngoặc kép chưa được đóng (bắt đầu ở dòng ${recordLine}).`);
  if (field !== '' || fields.length > 0) {
    fields.push(field);
    records.push({ line: recordLine, fields });
  }
  return records;
}

export function parseCsv(input: string): ParsedCsv {
  const text = input.replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const records = tokenize(text, detectDelimiter(firstLine)).filter((r) =>
    r.fields.some((f) => f.trim() !== ''),
  );
  const [header, ...body] = records;
  if (!header) throw new CsvFormatError('Tệp CSV trống.');
  const headers = header.fields.map((h) => h.trim().toLowerCase());
  const duplicate = headers.find((h, i) => h && headers.indexOf(h) !== i);
  if (duplicate) throw new CsvFormatError(`Cột "${duplicate}" bị lặp lại.`);

  const rows = body.map((r) => {
    if (r.fields.length > headers.length) {
      throw new CsvFormatError(
        `Dòng ${r.line} có ${r.fields.length} cột, nhiều hơn tiêu đề (${headers.length}).`,
      );
    }
    const values: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h) values[h] = unguard((r.fields[i] ?? '').trim());
    });
    return { line: r.line, values };
  });
  return { headers, rows };
}

/** Leading characters that make Excel treat a cell as a formula (CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

function escapeField(raw: string): string {
  // Neutralise formulas with a leading apostrophe; parseCsv strips it again on import.
  const value = FORMULA_START.test(raw) ? `'${raw}` : raw;
  return /[",\r\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Reverses the formula guard added by toCsv. */
function unguard(value: string): string {
  return value.startsWith("'") && FORMULA_START.test(value.slice(1)) ? value.slice(1) : value;
}

/** Writes CSV with a BOM so Excel opens Vietnamese text as UTF-8. */
export function toCsv(
  columns: string[],
  rows: Record<string, string | null | undefined>[],
): string {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => escapeField(row[c] ?? '')).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export interface ImportIssue {
  line: number;
  column?: string;
  message: string;
}

/** Reports required columns missing from a parsed file. */
export function missingColumns(parsed: ParsedCsv, required: readonly string[]): string[] {
  return required.filter((c) => !parsed.headers.includes(c));
}
