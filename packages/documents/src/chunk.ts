/**
 * Splits extracted text into retrieval chunks (spec 8.9: ~800 tokens, 100 overlap). Tokens
 * are estimated at 4 characters; breaks fall on paragraph, then sentence, boundaries. Page
 * markers written by the extractor ("--- Trang N ---", "--- Trang chiếu N ---") are removed
 * from the text and kept as the chunk's page.
 */
export const CHUNK_CHARS = 3_200;
export const OVERLAP_CHARS = 400;

export interface Chunk {
  index: number;
  text: string;
  /** Page (or slide) where the chunk starts; null when the source has no pages. */
  page: number | null;
}

const PAGE_MARKER = /^--- Trang(?: chiếu)? (\d+) ---$/;

interface Piece {
  text: string;
  page: number | null;
}

/** Paragraphs with their page, long paragraphs split by sentence or by length. */
function pieces(text: string, max: number): Piece[] {
  const out: Piece[] = [];
  let page: number | null = null;
  for (const raw of text.replace(/\r\n?/g, '\n').split(/\n{2,}|\n(?=--- Trang)/)) {
    const lines = raw.split('\n');
    const kept: string[] = [];
    for (const line of lines) {
      const m = line.trim().match(PAGE_MARKER);
      if (m) {
        if (kept.length) out.push(...split(kept.join('\n').trim(), page, max));
        kept.length = 0;
        page = Number(m[1]);
      } else {
        kept.push(line);
      }
    }
    const para = kept.join('\n').trim();
    if (para) out.push(...split(para, page, max));
  }
  return out;
}

function split(para: string, page: number | null, max: number): Piece[] {
  if (para.length <= max) return [{ text: para, page }];
  const sentences = para.match(/[^.!?。\n]+[.!?。]*\s*|\n+/g) ?? [para];
  const out: Piece[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length > max) {
      out.push({ text: cur.trim(), page });
      cur = '';
    }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) out.push({ text: s.slice(i, i + max).trim(), page });
    } else {
      cur += s;
    }
  }
  if (cur.trim()) out.push({ text: cur.trim(), page });
  return out;
}

/** The end of `text`, about `size` characters, starting at a sentence or word boundary. */
function tail(text: string, size: number): string {
  if (text.length <= size) return text;
  const cut = text.slice(text.length - size);
  const sentence = cut.search(/[.!?]\s+\S/);
  if (sentence >= 0 && sentence < size / 2) return cut.slice(sentence + 1).trim();
  const space = cut.indexOf(' ');
  return space >= 0 ? cut.slice(space + 1) : cut;
}

export function chunkText(text: string, size = CHUNK_CHARS, overlap = OVERLAP_CHARS): Chunk[] {
  const chunks: Chunk[] = [];
  let cur = '';
  let page: number | null = null;
  let fresh = 0; // characters added since the overlap
  const flush = () => {
    if (fresh > 0 && cur.trim()) chunks.push({ index: chunks.length, text: cur.trim(), page });
  };
  for (const p of pieces(text, size - overlap)) {
    if (cur && cur.length + p.text.length + 2 > size) {
      flush();
      cur = tail(cur, overlap);
      fresh = 0;
      page = p.page;
    }
    if (!cur) page = p.page;
    cur = cur ? `${cur}\n\n${p.text}` : p.text;
    fresh += p.text.length;
  }
  flush();
  return chunks;
}
