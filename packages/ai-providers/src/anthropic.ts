import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import type { AuthClient } from 'google-auth-library';
import { isAbortError, toErrorChunk } from './errors.js';
import { estimatedUsage } from './openai.js';
import type {
  ChatChunk,
  LLMProvider,
  NormalizedChatRequest,
  StopReason,
  Transport,
} from './types.js';

export type AnthropicProviderOptions =
  | { transport: 'direct'; apiKey: string; fetch?: typeof fetch; baseURL?: string }
  | {
      transport: 'vertex';
      projectId: string;
      /** Vertex AI location; "global" is recommended for Claude. */
      region: string;
      /** Defaults to Application Default Credentials (the Cloud Run service account). */
      authClient?: AuthClient;
      fetch?: typeof fetch;
    };

/**
 * Registry ids use the Vertex AI form for dated snapshots ("claude-haiku-4-5@20251001");
 * the Claude API spells the same snapshot "claude-haiku-4-5-20251001".
 */
export function anthropicModelFor(transport: Transport, model: string): string {
  return transport === 'direct' ? model.replace('@', '-') : model;
}

const STOP_REASONS: Record<string, StopReason> = {
  end_turn: 'end',
  stop_sequence: 'end',
  tool_use: 'end',
  pause_turn: 'end',
  max_tokens: 'max_tokens',
  model_context_window_exceeded: 'max_tokens',
  refusal: 'refusal',
};

/**
 * Claude through the Claude API (direct, key) or Vertex AI (service account). Thinking
 * is left at the model default; depth comes from the registry's `reasoningEffort`.
 * Refusals end with stopReason "refusal" so the gateway can fall back (M8); the
 * server-side `fallbacks` parameter is not used because the ledger must record the
 * model that actually answered and Vertex AI does not support it.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic' as const;
  readonly transport: Transport;
  private readonly client: Anthropic | AnthropicVertex;

  constructor(options: AnthropicProviderOptions) {
    this.transport = options.transport;
    this.client =
      options.transport === 'direct'
        ? new Anthropic({
            apiKey: options.apiKey,
            baseURL: options.baseURL,
            fetch: options.fetch,
            maxRetries: 1,
          })
        : new AnthropicVertex({
            projectId: options.projectId,
            region: options.region,
            authClient: options.authClient,
            fetch: options.fetch,
            maxRetries: 1,
          });
  }

  async *stream(req: NormalizedChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages: Anthropic.MessageParam[] = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    let text = '';
    let input = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let output = 0;
    let sawUsage = false;
    let stopReason: StopReason = 'end';
    const usage = (): Extract<ChatChunk, { type: 'usage' }> =>
      sawUsage
        ? {
            type: 'usage',
            // Cache writes are billed as input here (no cache_control is set yet).
            inputTokens: input + cacheWrite,
            outputTokens: output,
            cachedInputTokens: cacheRead,
          }
        : estimatedUsage(req, text);

    try {
      const stream = this.client.messages.stream(
        {
          model: anthropicModelFor(this.transport, req.model),
          max_tokens: req.maxOutputTokens,
          messages,
          ...(system ? { system } : {}),
          ...(req.reasoningEffort ? { output_config: { effort: req.reasoningEffort } } : {}),
        },
        { signal },
      );
      for await (const event of stream) {
        if (event.type === 'message_start') {
          const u = event.message.usage;
          sawUsage = true;
          input = u.input_tokens;
          cacheRead = u.cache_read_input_tokens ?? 0;
          cacheWrite = u.cache_creation_input_tokens ?? 0;
          output = u.output_tokens;
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          text += event.delta.text;
          yield { type: 'text', delta: event.delta.text };
        } else if (event.type === 'message_delta') {
          // message_delta usage is cumulative; input counts may be refined here too.
          const u = event.usage;
          sawUsage = true;
          output = u.output_tokens;
          if (u.input_tokens != null) input = u.input_tokens;
          if (u.cache_read_input_tokens != null) cacheRead = u.cache_read_input_tokens;
          if (u.cache_creation_input_tokens != null) cacheWrite = u.cache_creation_input_tokens;
          if (event.delta.stop_reason) stopReason = STOP_REASONS[event.delta.stop_reason] ?? 'end';
        }
      }
    } catch (err) {
      if (isAbortError(err, signal)) {
        yield usage();
        yield { type: 'done', stopReason: 'cancelled' };
        return;
      }
      if (text) yield usage();
      yield toErrorChunk('Anthropic', err);
      return;
    }
    yield usage();
    // Some SDKs end the iteration quietly instead of throwing when aborted.
    yield { type: 'done', stopReason: signal?.aborted ? 'cancelled' : stopReason };
  }
}
