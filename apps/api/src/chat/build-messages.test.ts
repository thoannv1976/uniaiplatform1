import { DEFAULT_SYSTEM_PROMPT } from '@uniai/shared';
import { describe, expect, it } from 'vitest';
import { buildMessages } from './chat.service.js';

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
