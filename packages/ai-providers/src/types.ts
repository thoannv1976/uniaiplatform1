export type ProviderId = 'openai' | 'gemini' | 'anthropic' | 'mock';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Provider-neutral request built by the AI Gateway. */
export interface NormalizedChatRequest {
  /** Model id as the provider expects it, taken from the Model Registry. */
  model: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
}

export type ChatChunk =
  | { type: 'text'; delta: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cachedInputTokens: number }
  | { type: 'done'; stopReason: 'end' | 'max_tokens' | 'refusal' | 'cancelled' }
  | { type: 'error'; code: string; message: string; retryable: boolean };

export interface LLMProvider {
  readonly id: ProviderId;
  /**
   * Streams a response. Implementations must always emit exactly one `usage` chunk
   * before `done` (also on cancellation) so the gateway can settle the cost.
   */
  stream(req: NormalizedChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>;
}
