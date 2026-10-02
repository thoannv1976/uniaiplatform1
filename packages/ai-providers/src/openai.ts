import OpenAI from 'openai';
import { estimateTokens, isAbortError, toErrorChunk } from './errors.js';
import type { ChatChunk, LLMProvider, NormalizedChatRequest, StopReason } from './types.js';

export interface OpenAIProviderOptions {
  apiKey: string;
  /** For tests: replays recorded HTTP instead of calling the network. */
  fetch?: typeof fetch;
  baseURL?: string;
  maxRetries?: number;
}

/**
 * OpenAI through the Responses API (direct transport only). `store: false` keeps
 * conversations out of OpenAI's server-side storage.
 */
export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai' as const;
  readonly transport = 'direct' as const;
  private readonly client: OpenAI;

  constructor(options: OpenAIProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      fetch: options.fetch,
      maxRetries: options.maxRetries ?? 1,
    });
  }

  async *stream(req: NormalizedChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const instructions = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const input = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    let text = '';
    let usage: Extract<ChatChunk, { type: 'usage' }> | null = null;
    let stopReason: StopReason = 'end';
    try {
      const events = await this.client.responses.create(
        {
          model: req.model,
          input,
          ...(instructions ? { instructions } : {}),
          max_output_tokens: req.maxOutputTokens,
          ...(req.reasoningEffort ? { reasoning: { effort: req.reasoningEffort } } : {}),
          store: false,
          stream: true,
        },
        { signal },
      );
      for await (const event of events) {
        switch (event.type) {
          case 'response.output_text.delta':
            text += event.delta;
            yield { type: 'text', delta: event.delta };
            break;
          case 'response.refusal.delta':
            stopReason = 'refusal';
            text += event.delta;
            yield { type: 'text', delta: event.delta };
            break;
          case 'response.completed':
          case 'response.incomplete': {
            const u = event.response.usage;
            if (u) {
              const cached = u.input_tokens_details?.cached_tokens ?? 0;
              usage = {
                type: 'usage',
                inputTokens: Math.max(0, u.input_tokens - cached),
                outputTokens: u.output_tokens,
                cachedInputTokens: cached,
              };
            }
            const reason = event.response.incomplete_details?.reason;
            if (reason === 'max_output_tokens') stopReason = 'max_tokens';
            else if (reason === 'content_filter') stopReason = 'refusal';
            break;
          }
          case 'response.failed':
            throw Object.assign(new Error(event.response.error?.message ?? 'response failed'), {
              status: 500,
            });
          case 'error':
            throw Object.assign(new Error(event.message), { code: event.code });
          default:
            break;
        }
      }
    } catch (err) {
      if (isAbortError(err, signal)) {
        yield usage ?? estimatedUsage(req, text);
        yield { type: 'done', stopReason: 'cancelled' };
        return;
      }
      if (text) yield usage ?? estimatedUsage(req, text);
      yield toErrorChunk('OpenAI', err);
      return;
    }
    yield usage ?? estimatedUsage(req, text);
    // Some SDKs end the iteration quietly instead of throwing when aborted.
    yield { type: 'done', stopReason: signal?.aborted ? 'cancelled' : stopReason };
  }
}

/** Fallback when the stream ended without a usage report (e.g. cancelled). */
export function estimatedUsage(
  req: NormalizedChatRequest,
  output: string,
): Extract<ChatChunk, { type: 'usage' }> {
  return {
    type: 'usage',
    inputTokens: req.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0),
    outputTokens: estimateTokens(output),
    cachedInputTokens: 0,
  };
}
