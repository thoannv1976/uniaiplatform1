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

    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const directives = parseMockDirectives(lastUser?.content ?? '');

    const failWith = this.options.failWith ?? directives.failWith;
    if (failWith) {
      yield { type: 'error', ...failWith };
      return;
    }

    let emitted = '';
    // "[mock:slow=N]": one chunk per second for N seconds, to test long streams (> 60 s).
    for (let second = 1; second <= directives.slowSeconds; second++) {
      if (signal?.aborted) break;
      const tick = `${second}… `;
      emitted += tick;
      yield { type: 'text', delta: tick };
      await sleep(1000, signal);
    }
    const words = `[mock:${req.model}] ${lastUser?.content ?? ''}`.split(/(\s+)/).filter(Boolean);

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

const FAILURES: Record<
  string,
  { code: string; message: string; retryable: boolean; status: number }
> = {
  '429': { code: 'rate_limited', message: 'mock: HTTP 429', retryable: true, status: 429 },
  '500': { code: 'unavailable', message: 'mock: HTTP 500', retryable: true, status: 500 },
  '401': { code: 'auth', message: 'mock: HTTP 401', retryable: false, status: 401 },
};

/**
 * Test switches understood by the mock only (staging/emulator): "[mock:slow=75]" streams for
 * 75 seconds; "[mock:fail=429|500|401]" fails before answering.
 */
export function parseMockDirectives(text: string): {
  slowSeconds: number;
  failWith?: (typeof FAILURES)[string];
} {
  const slow = /\[mock:slow=(\d{1,3})\]/.exec(text);
  const fail = /\[mock:fail=(\d{3})\]/.exec(text);
  return {
    slowSeconds: slow ? Math.min(Number(slow[1]), 900) : 0,
    failWith: fail ? FAILURES[fail[1] ?? ''] : undefined,
  };
}

const usage = (inputTokens: number, emitted: string): ChatChunk => ({
  type: 'usage',
  inputTokens,
  outputTokens: estimateTokens(emitted),
  cachedInputTokens: 0,
});
