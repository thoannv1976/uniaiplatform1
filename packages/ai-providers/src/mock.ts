import { estimateTokens } from './errors.js';
import type { ChatChunk, LLMProvider, NormalizedChatRequest } from './types.js';

export { estimateTokens };

export interface MockProviderOptions {
  /** Delay between streamed chunks in ms. */
  chunkDelayMs?: number;
  /** Fail before streaming anything, e.g. to exercise fallback. */
  failWith?: { code: string; message: string; retryable: boolean; status?: number };
  /** Fail after this many words have been streamed (a dropped connection). */
  failAfterWords?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Deterministic provider for local development and tests: echoes the last user message
 * word by word. Never calls the network and never costs money.
 */
export class MockProvider implements LLMProvider {
  readonly id = 'mock' as const;
  readonly transport = 'direct' as const;

  constructor(private readonly options: MockProviderOptions = {}) {}

  async *stream(req: NormalizedChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const inputTokens = req.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);

    if (this.options.failWith) {
      yield { type: 'error', ...this.options.failWith };
      return;
    }

    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const words = `[mock:${req.model}] ${lastUser?.content ?? ''}`.split(/(\s+)/).filter(Boolean);

    let emitted = '';
    let stopReason: 'end' | 'max_tokens' | 'cancelled' = 'end';
    let count = 0;
    for (const word of words) {
      if (signal?.aborted) {
        stopReason = 'cancelled';
        break;
      }
      if (estimateTokens(emitted + word) > req.maxOutputTokens) {
        stopReason = 'max_tokens';
        break;
      }
      if (this.options.failAfterWords !== undefined && count >= this.options.failAfterWords) {
        yield usage(inputTokens, emitted);
        yield {
          type: 'error',
          code: 'unavailable',
          message: 'mock: kết nối bị ngắt',
          retryable: true,
        };
        return;
      }
      emitted += word;
      count += 1;
      yield { type: 'text', delta: word };
      await sleep(this.options.chunkDelayMs ?? 0, signal);
    }

    yield usage(inputTokens, emitted);
    yield { type: 'done', stopReason };
  }
}

const usage = (inputTokens: number, emitted: string): ChatChunk => ({
  type: 'usage',
  inputTokens,
  outputTokens: estimateTokens(emitted),
  cachedInputTokens: 0,
});
