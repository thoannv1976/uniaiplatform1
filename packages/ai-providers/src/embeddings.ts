import { GoogleGenAI } from '@google/genai';

/**
 * Text embeddings for the Knowledge Base (spec 8.9). Vertex AI
 * `text-multilingual-embedding-002` (768 dimensions, Vietnamese supported) in production;
 * MockEmbedder in tests (no network).
 */
export const EMBEDDING_DIMENSIONS = 768;

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  /** One vector per text; `kind` tunes the vectors for stored passages or search queries. */
  embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]>;
}

/** Inputs per request: the model accepts up to 20k tokens per call (~1k tokens per chunk). */
const BATCH = 10;

export class VertexEmbedder implements Embedder {
  readonly dimensions = EMBEDDING_DIMENSIONS;
  private readonly ai: GoogleGenAI;

  constructor(
    project: string,
    location = 'asia-southeast1',
    readonly model = 'text-multilingual-embedding-002',
  ) {
    this.ai = new GoogleGenAI({ vertexai: true, project, location });
  }

  async embed(texts: string[], kind: 'document' | 'query'): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const res = await this.ai.models.embedContent({
        model: this.model,
        contents: texts.slice(i, i + BATCH),
        config: {
          taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
          outputDimensionality: this.dimensions,
        },
      });
      for (const e of res.embeddings ?? []) {
        if (!e.values || e.values.length !== this.dimensions) {
          throw new Error('Vertex AI trả về embedding không hợp lệ');
        }
        out.push(e.values);
      }
    }
    if (out.length !== texts.length) throw new Error('Vertex AI trả thiếu embedding');
    return out;
  }
}

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic bag-of-words vectors (words and word pairs hashed into 768 buckets,
 * normalized): texts sharing words are close, so retrieval can be tested offline.
 */
export class MockEmbedder implements Embedder {
  readonly model = 'mock-embedding';
  readonly dimensions = EMBEDDING_DIMENSIONS;
  calls = 0;

  embed(texts: string[], _kind?: 'document' | 'query'): Promise<number[][]> {
    this.calls += 1;
    return Promise.resolve(
      texts.map((t) => {
        const v = new Array<number>(this.dimensions).fill(0);
        const words = fold(t).match(/[\p{L}\p{N}]+/gu) ?? [];
        words.forEach((w, i) => {
          if (w.length < 2) return;
          v[hash(w) % this.dimensions]! += 1;
          const next = words[i + 1];
          if (next) v[hash(`${w} ${next}`) % this.dimensions]! += 0.5;
        });
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
      }),
    );
  }
}
