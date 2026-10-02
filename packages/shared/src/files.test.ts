import { describe, expect, it } from 'vitest';
import { chatRequestSchema } from './chat.js';
import { FILE_ACCEPT, fileTypeOf, formatBytes } from './files.js';

describe('fileTypeOf', () => {
  it('decides the kind by extension and normalizes the MIME type', () => {
    expect(fileTypeOf('Báo cáo.PDF', 'application/pdf')).toEqual({
      kind: 'pdf',
      mime: 'application/pdf',
    });
    expect(fileTypeOf('ghi-chu.md', '')).toEqual({ kind: 'text', mime: 'text/markdown' });
    expect(fileTypeOf('ds.csv', 'application/vnd.ms-excel')).toEqual({
      kind: 'text',
      mime: 'text/csv',
    });
    expect(fileTypeOf('anh.jpeg', 'image/jpeg')?.kind).toBe('image');
    expect(fileTypeOf('bang.xlsx', 'application/octet-stream')?.kind).toBe('xlsx');
  });

  it('refuses unknown types and mismatched declarations', () => {
    expect(fileTypeOf('setup.exe', 'application/x-msdownload')).toBeNull();
    expect(fileTypeOf('cu.doc', 'application/msword')).toBeNull();
    expect(fileTypeOf('anh.png', 'application/pdf')).toBeNull();
    expect(fileTypeOf('khong-duoi', 'text/plain')).toBeNull();
  });

  it('lists accepted types for the file picker', () => {
    expect(FILE_ACCEPT).toContain('.pptx');
    expect(FILE_ACCEPT).toContain('image/png');
  });
});

describe('chat request with files', () => {
  it('accepts up to 5 file ids', () => {
    const ids = ['a1', 'b2', 'c3', 'd4', 'e5'];
    expect(chatRequestSchema.parse({ message: 'Tóm tắt', fileIds: ids }).fileIds).toEqual(ids);
    expect(chatRequestSchema.safeParse({ message: 'x', fileIds: [...ids, 'f6'] }).success).toBe(
      false,
    );
    expect(chatRequestSchema.safeParse({ message: 'x', fileIds: ['../x'] }).success).toBe(false);
  });
});

describe('formatBytes', () => {
  it('formats sizes in Vietnamese style', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024 + 200_000)).toBe('5,2 MB');
  });
});
