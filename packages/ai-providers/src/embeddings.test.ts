import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSIONS, MockEmbedder } from './embeddings.js';

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

describe('MockEmbedder', () => {
  it('gives normalized vectors where shared words mean closeness', async () => {
    const e = new MockEmbedder();
    const [doc1, doc2, q] = await e.embed(
      [
        'Sinh viên được bảo lưu kết quả học tập tối đa 2 năm',
        'Học phí được miễn giảm cho sinh viên có hoàn cảnh khó khăn',
        'bảo lưu kết quả học tập bao lâu',
      ],
      'document',
    );
    expect(doc1).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(cosine(doc1!, doc1!)).toBeCloseTo(1, 6);
    expect(cosine(q!, doc1!)).toBeGreaterThan(cosine(q!, doc2!));
  });
});
