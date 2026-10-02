import { MAX_EXTRACTED_CHARS, type FileKind } from '@uniai/shared';
import { strFromU8, unzipSync } from 'fflate';

/** A file that cannot be used; the message is shown to the user. */
export class FileContentError extends Error {}

export interface Extracted {
  /** Null for images (sent to the model as images). */
  text: string | null;
  /** Pages (PDF, Word when known), slides (PowerPoint) or sheets (Excel). */
  pages: number | null;
  truncated: boolean;
}

/** Office files are zip archives; refuse ones that inflate to more than this (zip bombs). */
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;

const startsWith = (data: Uint8Array, bytes: number[], offset = 0) =>
  bytes.every((b, i) => data[offset + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** True when the first bytes match the kind (the browser's MIME type is not trusted). */
export function matchesKind(kind: FileKind, data: Uint8Array): boolean {
  switch (kind) {
    case 'pdf':
      return startsWith(data, ascii('%PDF-'));
    case 'docx':
    case 'xlsx':
    case 'pptx':
      return startsWith(data, [0x50, 0x4b, 0x03, 0x04]);
    case 'image':
      return (
        startsWith(data, [0x89, 0x50, 0x4e, 0x47]) || // PNG
        startsWith(data, [0xff, 0xd8, 0xff]) || // JPEG
        startsWith(data, ascii('GIF8')) ||
        (startsWith(data, ascii('RIFF')) && startsWith(data, ascii('WEBP'), 8))
      );
    case 'text':
      return (
        startsWith(data, [0xff, 0xfe]) ||
        startsWith(data, [0xfe, 0xff]) ||
        !data.subarray(0, 8192).includes(0)
      );
  }
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e] ?? '';
  });
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function unzip(data: Uint8Array, wanted: (name: string) => boolean): Record<string, string> {
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (f) => {
        if (!wanted(f.name)) return false;
        total += f.originalSize;
        if (total > MAX_UNZIPPED_BYTES) throw new FileContentError('Tệp giải nén quá lớn.');
        return true;
      },
    });
  } catch (err) {
    if (err instanceof FileContentError) throw err;
    throw new FileContentError('Tệp Office bị hỏng hoặc không đúng định dạng.');
  }
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
}

const byNumber = (prefix: RegExp) => (a: string, b: string) =>
  Number(a.replace(prefix, '').replace(/\D/g, '')) -
  Number(b.replace(prefix, '').replace(/\D/g, ''));

/** Word: paragraphs, tabs, line breaks and table cells of word/document.xml. */
export function docxText(data: Uint8Array): { text: string; pages: number | null } {
  const parts = unzip(data, (n) => n === 'word/document.xml' || n === 'docProps/app.xml');
  const xml = parts['word/document.xml'];
  if (!xml) throw new FileContentError('Không tìm thấy nội dung tài liệu Word.');
  let out = '';
  const token = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br(?:\s[^>]*)?\/>|<\/w:p>|<\/w:tc>/g;
  for (const m of xml.matchAll(token)) {
    if (m[1] !== undefined) out += decodeEntities(m[1]);
    else if (m[0] === '<w:tab/>') out += '\t';
    else if (m[0] === '</w:tc>') out += ' | ';
    else out += '\n';
  }
  const pages = parts['docProps/app.xml']?.match(/<Pages>(\d+)<\/Pages>/)?.[1];
  return { text: tidy(out), pages: pages ? Number(pages) : null };
}

/** PowerPoint: the text of each slide, in order. */
export function pptxText(data: Uint8Array): { text: string; pages: number } {
  const parts = unzip(data, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const slides = Object.keys(parts).sort(byNumber(/^ppt\/slides\/slide/));
  if (slides.length === 0) throw new FileContentError('Không tìm thấy trang chiếu nào.');
  const text = slides
    .map((name, i) => {
      let body = '';
      for (const m of parts[name]!.matchAll(/<a:t>([^<]*)<\/a:t>|<\/a:p>|<a:br\/>/g)) {
        body += m[1] !== undefined ? decodeEntities(m[1]) : '\n';
      }
      return `--- Trang chiếu ${i + 1} ---\n${tidy(body)}`;
    })
    .join('\n\n');
  return { text, pages: slides.length };
}

const columnIndex = (letters: string) =>
  [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

/** Excel: each sheet as tab-separated rows (shared strings, inline strings, numbers). */
export function xlsxText(data: Uint8Array): { text: string; pages: number } {
  const parts = unzip(
    data,
    (n) =>
      n === 'xl/workbook.xml' ||
      n === 'xl/_rels/workbook.xml.rels' ||
      n === 'xl/sharedStrings.xml' ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  );
  const workbook = parts['xl/workbook.xml'];
  if (!workbook) throw new FileContentError('Không tìm thấy nội dung bảng tính Excel.');
  const shared = [...(parts['xl/sharedStrings.xml'] ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    (m) =>
      decodeEntities([...m[1]!.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join('')),
  );
  const targets = new Map(
    [...(parts['xl/_rels/workbook.xml.rels'] ?? '').matchAll(/<Relationship\s[^>]*>/g)].map((m) => [
      m[0].match(/Id="([^"]+)"/)?.[1],
      m[0].match(/Target="([^"]+)"/)?.[1]?.replace(/^\/?(xl\/)?/, 'xl/'),
    ]),
  );
  const sheets = [...workbook.matchAll(/<sheet\s[^>]*\/?>/g)].map((m) => ({
    name: decodeEntities(m[0].match(/name="([^"]*)"/)?.[1] ?? ''),
    path: targets.get(m[0].match(/r:id="([^"]+)"/)?.[1]),
  }));
  const out: string[] = [];
  for (const sheet of sheets) {
    const xml = sheet.path ? parts[sheet.path] : undefined;
    if (!xml) continue;
    const rows: string[] = [];
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1]!.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]!;
        const body = c[2] ?? '';
        const type = attrs.match(/\bt="([^"]+)"/)?.[1];
        const v = body.match(/<v>([^<]*)<\/v>/)?.[1];
        let value = '';
        if (type === 's' && v !== undefined) value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr')
          value = decodeEntities(
            [...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join(''),
          );
        else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (v !== undefined) value = decodeEntities(v);
        const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
        const col = ref ? columnIndex(ref) : cells.length;
        while (cells.length < col) cells.push('');
        cells[col] = value.replace(/[\t\n]+/g, ' ');
      }
      if (cells.some((c) => c !== '')) rows.push(cells.join('\t'));
    }
    out.push(`### Trang tính: ${sheet.name}\n${rows.join('\n')}`);
  }
  return { text: out.join('\n\n'), pages: sheets.length };
}

/** PDF: text of every page (scanned PDFs without a text layer give little or no text). */
export async function pdfText(data: Uint8Array): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  try {
    // pdf.js takes ownership of (detaches) the buffer it is given: pass a copy.
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const body = text.map((page, i) => `--- Trang ${i + 1} ---\n${tidy(page)}`).join('\n\n');
    return { text: body, pages: totalPages };
  } catch {
    throw new FileContentError('Không đọc được tệp PDF (tệp hỏng hoặc có mật khẩu).');
  }
}

function textOf(data: Uint8Array): string {
  if (startsWith(data, [0xff, 0xfe])) return new TextDecoder('utf-16le').decode(data.subarray(2));
  if (startsWith(data, [0xfe, 0xff])) return new TextDecoder('utf-16be').decode(data.subarray(2));
  return new TextDecoder('utf-8').decode(data).replace(/^\uFEFF/, '');
}

/**
 * Checks a file against its kind and extracts its text. Throws FileContentError with a
 * Vietnamese message for files that cannot be used.
 */
export async function extract(
  kind: FileKind,
  data: Uint8Array,
  limits: { maxPages: number },
): Promise<Extracted> {
  if (!matchesKind(kind, data)) {
    throw new FileContentError('Nội dung tệp không khớp với loại tệp (đuôi tệp).');
  }
  if (kind === 'image') return { text: null, pages: null, truncated: false };
  const result =
    kind === 'pdf'
      ? await pdfText(data)
      : kind === 'docx'
        ? docxText(data)
        : kind === 'pptx'
          ? pptxText(data)
          : kind === 'xlsx'
            ? xlsxText(data)
            : { text: tidy(textOf(data)), pages: null };
  if (result.pages !== null && result.pages > limits.maxPages) {
    throw new FileContentError(
      `Tệp có ${result.pages} trang, vượt giới hạn ${limits.maxPages} trang.`,
    );
  }
  if (kind === 'pdf' && result.text.replace(/--- Trang \d+ ---/g, '').trim() === '') {
    throw new FileContentError(
      'PDF không có lớp chữ (có thể là bản scan). Hãy chụp trang cần hỏi và gửi dạng ảnh.',
    );
  }
  const truncated = result.text.length > MAX_EXTRACTED_CHARS;
  return {
    text: truncated ? result.text.slice(0, MAX_EXTRACTED_CHARS) : result.text,
    pages: result.pages,
    truncated,
  };
}
