import type { ProviderId, ReasoningEffort, Transport } from '@uniai/shared';

export type { ProviderId, ReasoningEffort, Transport };

/** An image attached to a user message (base64, at most ~5 MB). */
export interface ImageInput {
  mime: string;
  data: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Only on user messages, and only for models with the "image" capability. */
  images?: ImageInput[];
}

/** Rough input cost of one image, used for estimates (providers bill ~250–1,600 tokens). */
export const IMAGE_TOKEN_ESTIMATE = 1_600;

/** Provider-neutral request built by the AI Gateway. */
export interface NormalizedChatRequest {
  /** Model id as the provider expects it, taken from the Model Registry (`apiModelId`). */
  model: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
  /** From the model's registry defaults; omitted = provider default. */
  reasoningEffort?: ReasoningEffort;
}

export type StopReason = 'end' | 'max_tokens' | 'refusal' | 'cancelled';

/** Normalized error codes; `retryable` tells the gateway whether a fallback may help. */
export type ProviderErrorCode =
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'auth'
  | 'invalid_request'
  | 'not_found'
  | 'not_configured'
  | 'unknown';

export type ChatChunk =
  | { type: 'text'; delta: string }
  /**
   * `inputTokens` excludes cached input tokens, which are counted separately so they can be
   * billed at the cached price (see `usageCost` in @uniai/shared). Reasoning/thinking tokens
   * are billed as output and included in `outputTokens`.
   */
  | { type: 'usage'; inputTokens: number; outputTokens: number; cachedInputTokens: number }
  | { type: 'done'; stopReason: StopReason }
  | { type: 'error'; code: string; message: string; retryable: boolean; status?: number };

export interface LLMProvider {
  readonly id: ProviderId;
  readonly transport: Transport;
  /**
   * Streams a response. Contract (checked by contract.test.ts for every adapter):
   * - a successful stream ends with exactly one `usage` chunk followed by `done`
   *   (also on cancellation, so the gateway can settle the cost);
   * - a failed stream ends with one `error` chunk, preceded by `usage` only if the
   *   provider had already produced text;
   * - adapters never throw and never put API keys in error messages.
   */
  stream(req: NormalizedChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>;
}
