import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { extract, FileContentError, matchesKind } from './extract.js';
import { SAMPLE_PNG, sampleDocx, samplePdf, samplePptx, sampleXlsx } from './fixtures.js';

const limits = { maxPages: 200 };

describe('extract', () => {
  it('reads every page of a PDF', async () => {
    const r = await extract('pdf', samplePdf(['Hello FTU', 'Second page']), limits);
    expect(r.pages).toBe(2);
    expect(r.text).toContain('--- Trang 1 ---\nHello FTU');
    expect(r.text).toContain('--- Trang 2 ---\nSecond page');
  });

  it('refuses PDFs above the page limit and PDFs without text', async () => {
    await expect(extract('pdf', samplePdf(['a', 'b', 'c']), { maxPages: 2 })).rejects.toThrow(
      'Tệp có 3 trang, vượt giới hạn 2 trang.',
    );
    await expect(extract('pdf', samplePdf(['']), limits)).rejects.toThrow('PDF không có lớp chữ');
    await expect(extract('pdf', Buffer.from('%PDF-1.4 hỏng'), limits)).rejects.toBeInstanceOf(
      FileContentError,
    );
  });

  it('reads Word paragraphs, entities and tables', async () => {
    const r = await extract('docx', sampleDocx(), limits);
    expect(r.text).toBe('Quy chế đào tạo\nĐiều 1. Phạm vi & đối tượng\nHọc phần\n | Tín chỉ\n |');
    expect(r.pages).toBe(2);
  });

  it('reads PowerPoint slides in numeric order', async () => {
    const r = await extract('pptx', samplePptx(), limits);
    expect(r.pages).toBe(3);
    expect(r.text).toBe(
      '--- Trang chiếu 1 ---\nGiới thiệu\nMục tiêu môn học\n\n--- Trang chiếu 2 ---\nNội dung\n\n--- Trang chiếu 3 ---\nKết luận',
    );
  });

  it('reads Excel sheets with shared and inline strings, keeping columns', async () => {
    const r = await extract('xlsx', sampleXlsx(), limits);
    expect(r.pages).toBe(2);
    expect(r.text).toBe(
      '### Trang tính: Điểm\nHọ tên\t\tĐiểm\nNguyễn Văn A\t\t8.5\tĐạt\n\n### Trang tính: Trống\n',
    );
  });

  it('reads UTF-8 and UTF-16 text and images pass through', async () => {
    expect((await extract('text', Buffer.from('﻿xin chào\r\n'), limits)).text).toBe('xin chào');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('chào', 'utf16le')]);
    expect((await extract('text', utf16, limits)).text).toBe('chào');
    expect(await extract('image', SAMPLE_PNG, limits)).toEqual({
      text: null,
      pages: null,
      truncated: false,
    });
  });

  it('checks the first bytes against the kind', async () => {
    expect(matchesKind('image', samplePdf(['x']))).toBe(false);
    expect(matchesKind('pdf', sampleDocx())).toBe(false);
    expect(matchesKind('text', Buffer.from([0x61, 0, 0x62]))).toBe(false);
    await expect(extract('image', Buffer.from('<svg/>'), limits)).rejects.toThrow(
      'Nội dung tệp không khớp',
    );
    const notWord = Buffer.from(zipSync({ 'a.txt': strToU8('x') }));
    await expect(extract('docx', notWord, limits)).rejects.toThrow('Không tìm thấy nội dung');
    await expect(
      extract('xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), limits),
    ).rejects.toThrow('Tệp Office bị hỏng');
  });

  it('cuts very long text and flags it', async () => {
    const r = await extract('text', Buffer.from('a'.repeat(1_000_050)), limits);
    expect(r.truncated).toBe(true);
    expect(r.text).toHaveLength(1_000_000);
  });
});
