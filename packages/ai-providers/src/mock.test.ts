import { describe, expect, it } from 'vitest';
import { MockProvider, parseMockDirectives } from './mock.js';
import type { ChatChunk, NormalizedChatRequest } from './types.js';

const req = (content: string, maxOutputTokens = 1000): NormalizedChatRequest => ({
  model: 'mock-economy',
  messages: [{ role: 'user', content }],
  maxOutputTokens,
});

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

describe('MockProvider', () => {
  it('echoes the user message deterministically and ends with usage then done', async () => {
    const chunks = await collect(new MockProvider().stream(req('Xin chào thế giới')));
    const text = chunks.flatMap((c) => (c.type === 'text' ? [c.delta] : [])).join('');
    expect(text).toBe('[mock:mock-economy] Xin chào thế giới');
    expect(chunks.at(-2)).toMatchObject({ type: 'usage', inputTokens: 5 });
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'end' });
  });

  it('stops at maxOutputTokens', async () => {
    const chunks = await collect(new MockProvider().stream(req('một hai ba bốn năm sáu', 6)));
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'max_tokens' });
    const usage = chunks.find((c) => c.type === 'usage');
    expect(usage && usage.type === 'usage' && usage.outputTokens).toBeLessThanOrEqual(6);
  });

  it('reports usage even when cancelled', async () => {
    const controller = new AbortController();
    const provider = new MockProvider({ chunkDelayMs: 5 });
    const chunks: ChatChunk[] = [];
    for await (const c of provider.stream(req('a b c d e f g h'), controller.signal)) {
      chunks.push(c);
      if (c.type === 'text') controller.abort();
    }
    expect(chunks.some((c) => c.type === 'usage')).toBe(true);
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'cancelled' });
  });

  it('can simulate a provider failure before streaming', async () => {
    const provider = new MockProvider({
      failWith: { code: 'unavailable', message: 'down', retryable: true },
    });
    const chunks = await collect(provider.stream(req('hi')));
    expect(chunks).toEqual([
      { type: 'error', code: 'unavailable', message: 'down', retryable: true },
    ]);
  });
});

describe('MockProvider directives', () => {
  it('parses slow and fail switches', () => {
    expect(parseMockDirectives('[mock:slow=75] chào')).toEqual({
      slowSeconds: 75,
      failWith: undefined,
    });
    expect(parseMockDirectives('[mock:slow=999]').slowSeconds).toBe(900);
    expect(parseMockDirectives('[mock:fail=429]').failWith).toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
    expect(parseMockDirectives('[mock:fail=418]').failWith).toBeUndefined();
  });

  it('fails on request and streams ticks while slow', async () => {
    const failed = await collect(new MockProvider().stream(req('[mock:fail=500] hi')));
    expect(failed).toEqual([
      {
        type: 'error',
        code: 'unavailable',
        message: 'mock: HTTP 500',
        retryable: true,
        status: 500,
      },
    ]);
    const started = Date.now();
    const slow = await collect(new MockProvider().stream(req('[mock:slow=1] hi')));
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(slow[0]).toEqual({ type: 'text', delta: '1… ' });
    expect(slow.at(-1)).toEqual({ type: 'done', stopReason: 'end' });
  });
});

describe('MockProvider tool directive', () => {
  it('answers with exactly the requested tool call', async () => {
    const chunks = [];
    for await (const c of new MockProvider().stream({
      model: 'mock-economy',
      messages: [
        { role: 'user', content: 'Tra cứu [mock:tool=lms.get_course {"courseId":"KT101"}]' },
      ],
      maxOutputTokens: 1000,
    })) {
      chunks.push(c);
    }
    const text = chunks.flatMap((c) => (c.type === 'text' ? [c.delta] : [])).join('');
    expect(JSON.parse(text)).toEqual({ tool: 'lms.get_course', arguments: { courseId: 'KT101' } });
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'end' });
  });
});
