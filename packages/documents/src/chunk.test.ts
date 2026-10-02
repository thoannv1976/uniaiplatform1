import { describe, expect, it } from 'vitest';
import { chunkText } from './chunk.js';

describe('chunkText', () => {
  it('keeps short text in one chunk without page markers', () => {
    expect(chunkText('--- Trang 1 ---\nĐiều 1. Phạm vi\n\nĐiều 2. Đối tượng')).toEqual([
      { index: 0, text: 'Điều 1. Phạm vi\n\nĐiều 2. Đối tượng', page: 1 },
    ]);
  });

  it('splits long text near the target size with overlap and pages', () => {
    const para = (n: number) => `Điều ${n}. ${'Quy định về đào tạo tín chỉ. '.repeat(20)}`;
    const text = Array.from({ length: 30 }, (_, i) =>
      i % 10 === 0 ? `--- Trang ${i / 10 + 1} ---\n${para(i)}` : para(i),
    ).join('\n\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(3_200 + 400);
    expect(chunks.every((c) => !c.text.includes('--- Trang'))).toBe(true);
    expect(chunks[0]!.page).toBe(1);
    expect(chunks.at(-1)!.page).toBe(3);
    // Consecutive chunks share text (overlap).
    const end = chunks[0]!.text.slice(-100);
    expect(chunks[1]!.text).toContain(end.slice(-40));
    // Every paragraph is somewhere.
    for (let i = 0; i < 30; i++)
      expect(chunks.some((c) => c.text.includes(`Điều ${i}.`))).toBe(true);
  });

  it('cuts a single huge paragraph', () => {
    const chunks = chunkText('x'.repeat(10_000));
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('returns nothing for empty text', () => {
    expect(chunkText('  \n\n --- Trang 1 --- \n')).toEqual([]);
  });
});
