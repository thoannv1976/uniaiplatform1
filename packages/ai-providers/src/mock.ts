import type { ChatChunk, LLMProvider, NormalizedChatRequest } from './types.js';

export interface MockProviderOptions {
  /** Delay between streamed chunks in ms. */
  chunkDelayMs?: number;
  /** Fail before streaming anything, e.g. to exercise fallback. */
  failWith?: { code: string; message: string; retryable: boolean };
}

/** Rough, deterministic token estimate used only by the mock (≈ 4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
    for (const word of words) {
      if (signal?.aborted) {
        stopReason = 'cancelled';
        break;
      }
      if (estimateTokens(emitted + word) > req.maxOutputTokens) {
        stopReason = 'max_tokens';
        break;
      }
      emitted += word;
      yield { type: 'text', delta: word };
      await sleep(this.options.chunkDelayMs ?? 0, signal);
    }

    yield {
      type: 'usage',
      inputTokens,
      outputTokens: estimateTokens(emitted),
      cachedInputTokens: 0,
    };
    yield { type: 'done', stopReason };
  }
}
