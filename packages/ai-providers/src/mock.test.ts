import { describe, expect, it } from 'vitest';
import { MockProvider } from './mock.js';
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
