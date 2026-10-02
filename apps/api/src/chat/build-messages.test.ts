import { DEFAULT_SYSTEM_PROMPT } from '@uniai/shared';
import { describe, expect, it } from 'vitest';
import type { LoadedAttachment } from '../files/files.service.js';
import { buildMessages, estimateInputTokens, withAttachments } from './chat.service.js';

describe('buildMessages', () => {
  it('keeps the newest history within budget, starts with the user and merges same roles', () => {
    const history = [
      { role: 'user' as const, content: 'cũ nhất – bị cắt' },
      { role: 'assistant' as const, content: 'trả lời cũ' },
      { role: 'user' as const, content: 'hỏi lỗi' },
      { role: 'user' as const, content: 'hỏi lại' },
      { role: 'assistant' as const, content: 'đáp' },
    ];
    const out = buildMessages(history, 'mới', 40);
    expect(out[0]).toEqual({ role: 'system', content: DEFAULT_SYSTEM_PROMPT });
    expect(out.slice(1)).toEqual([
      { role: 'user', content: 'hỏi lỗi\n\nhỏi lại' },
      { role: 'assistant', content: 'đáp' },
      { role: 'user', content: 'mới' },
    ]);
  });

  it('sends only the new message when nothing else fits', () => {
    expect(buildMessages([{ role: 'user', content: 'x'.repeat(100) }], 'mới', 10).slice(1)).toEqual(
      [{ role: 'user', content: 'mới' }],
    );
  });
});

const doc = (id: string, text: string, truncated = false): LoadedAttachment => ({
  ref: { id, name: `${id}.pdf`, kind: 'pdf' },
  text,
  truncated,
  image: null,
  available: true,
});
const img: LoadedAttachment = {
  ref: { id: 'i', name: 'anh.png', kind: 'image' },
  text: null,
  truncated: false,
  image: { mime: 'image/png', data: 'AAAA' },
  available: true,
};

describe('withAttachments', () => {
  it('puts documents before the question and shares the room fairly', () => {
    const out = withAttachments(
      'Tóm tắt',
      [doc('a', 'ngắn'), doc('b', 'x'.repeat(100))],
      30,
      false,
    );
    expect(out.content).toBe(
      '<tệp tên="a.pdf">\nngắn\n</tệp>\n\n' +
        `<tệp tên="b.pdf">\n${'x'.repeat(26)}\n[… phần còn lại của tệp đã được cắt bớt do giới hạn độ dài]\n</tệp>` +
        '\n\nTóm tắt',
    );
    expect(out.images).toBeUndefined();
  });

  it('sends images only to models that read them, and notes missing files', () => {
    const gone: LoadedAttachment = { ...doc('g', ''), text: null, available: false };
    expect(withAttachments('Ảnh gì?', [img, gone], 100, true)).toEqual({
      content: '[Tệp g.pdf (PDF) không còn được lưu trữ.]\n\nẢnh gì?',
      images: [{ mime: 'image/png', data: 'AAAA' }],
    });
    expect(withAttachments('Ảnh gì?', [img], 100, false).content).toContain(
      'model này không đọc được ảnh',
    );
    expect(withAttachments('Hỏi', [], 100, true)).toEqual({ content: 'Hỏi' });
  });

  it('keeps images when merging turns and counts them in the estimate', () => {
    const out = buildMessages([], { content: 'Ảnh gì?', images: [img.image!] }, 100);
    expect(out[1]).toEqual({ role: 'user', content: 'Ảnh gì?', images: [img.image] });
    expect(estimateInputTokens(out.slice(1))).toBe(Math.ceil(7 / 3) + 8 + 1600);
  });
});
