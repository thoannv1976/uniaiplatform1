import { describe, expect, it } from 'vitest';
import {
  chatRequestSchema,
  createSseParser,
  formatSseEvent,
  titleFromMessage,
  type ChatStreamEvent,
} from './chat.js';

describe('chat request', () => {
  it('defaults to AUTO and a new conversation; trims the message', () => {
    expect(chatRequestSchema.parse({ message: '  Xin chào ' })).toEqual({
      message: 'Xin chào',
      model: 'auto',
    });
  });

  it('rejects empty messages, odd ids and unknown fields', () => {
    expect(chatRequestSchema.safeParse({ message: '   ' }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ message: 'a', conversationId: '../x' }).success).toBe(
      false,
    );
    expect(chatRequestSchema.safeParse({ message: 'a', model: 'Bad Model' }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ message: 'a', stream: true }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ message: 'x'.repeat(32_001) }).success).toBe(false);
  });
});

describe('titleFromMessage', () => {
  it('uses the first line, shortened', () => {
    expect(titleFromMessage('Tóm tắt quy chế\nđào tạo')).toBe('Tóm tắt quy chế');
    expect(titleFromMessage('a'.repeat(100), 10)).toBe('aaaaaaaaa…');
    expect(titleFromMessage('   ')).toBe('Hội thoại mới');
  });
});

describe('SSE parser', () => {
  const events: ChatStreamEvent[] = [
    {
      type: 'meta',
      conversationId: 'c1',
      userMessageId: 'u1',
      messageId: 'm1',
      model: { id: 'mock-economy', displayName: 'Mock', providerId: 'mock', tier: 'economy' },
      routeReason: 'AUTO',
    },
    { type: 'delta', text: 'Xin chào\nthầy cô' },
    {
      type: 'done',
      messageId: 'm1',
      status: 'complete',
      stopReason: 'end',
      usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0 },
      cost: 3,
      latencyMs: 10,
    },
  ];

  it('round-trips events split at arbitrary points, skipping heartbeats', () => {
    const wire = `: ping\n\n${events.map(formatSseEvent).join(': ping\n\n')}`;
    for (const size of [1, 3, 7, wire.length]) {
      const got: ChatStreamEvent[] = [];
      const parser = createSseParser((e) => got.push(e));
      for (let i = 0; i < wire.length; i += size) parser.push(wire.slice(i, i + size));
      parser.end();
      expect(got).toEqual(events);
    }
  });

  it('ignores malformed and unknown events', () => {
    const got: ChatStreamEvent[] = [];
    const parser = createSseParser((e) => got.push(e));
    parser.push('data: not json\n\ndata: {"type":"other"}\n\n');
    parser.push('event: delta\r\ndata: {"type":"delta","text":"ok"}\r\n\r\n');
    expect(got).toEqual([{ type: 'delta', text: 'ok' }]);
  });
});
