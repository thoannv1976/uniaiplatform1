import { GoogleGenAI, ThinkingLevel, type Content } from '@google/genai';
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

export type GeminiProviderOptions =
  | { transport: 'direct'; apiKey: string; fetch?: typeof fetch }
  | {
      transport: 'vertex';
      project: string;
      /** Vertex AI location, e.g. "global". */
      location: string;
      /** Defaults to Application Default Credentials (the Cloud Run service account). */
      authClient?: AuthClient;
      fetch?: typeof fetch;
    };

const REFUSALS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
]);

const THINKING_LEVELS = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
} as const;

/** Gemini through the Gemini API (direct, key) or Vertex AI (service account). */
export class GeminiProvider implements LLMProvider {
  readonly id = 'gemini' as const;
  readonly transport: Transport;
  private readonly client: GoogleGenAI;

  constructor(options: GeminiProviderOptions) {
    this.transport = options.transport;
    const httpOptions = options.fetch ? { fetch: options.fetch } : undefined;
    this.client =
      options.transport === 'direct'
        ? new GoogleGenAI({ apiKey: options.apiKey, httpOptions })
        : new GoogleGenAI({
            vertexai: true,
            project: options.project,
            location: options.location,
            googleAuthOptions: options.authClient ? { authClient: options.authClient } : undefined,
            httpOptions,
          });
  }

  async *stream(req: NormalizedChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk> {
    const systemInstruction = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const contents: Content[] = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [
          ...(m.images ?? []).map((img) => ({
            inlineData: { mimeType: img.mime, data: img.data },
          })),
          { text: m.content },
        ],
      }));

    let text = '';
    let usage: Extract<ChatChunk, { type: 'usage' }> | null = null;
    let stopReason: StopReason = 'end';
    try {
      const stream = await this.client.models.generateContentStream({
        model: req.model,
        contents,
        config: {
          ...(systemInstruction ? { systemInstruction } : {}),
          maxOutputTokens: req.maxOutputTokens,
          ...(req.reasoningEffort
            ? { thinkingConfig: { thinkingLevel: THINKING_LEVELS[req.reasoningEffort] } }
            : {}),
          abortSignal: signal,
        },
      });
      for await (const chunk of stream) {
        if (chunk.promptFeedback?.blockReason) stopReason = 'refusal';
        const candidate = chunk.candidates?.[0];
        for (const part of candidate?.content?.parts ?? []) {
          // Thought summaries are not shown to users.
          if (part.text && !part.thought) {
            text += part.text;
            yield { type: 'text', delta: part.text };
          }
        }
        const finish = candidate?.finishReason;
        if (finish === 'MAX_TOKENS') stopReason = 'max_tokens';
        else if (finish && REFUSALS.has(finish)) stopReason = 'refusal';
        const u = chunk.usageMetadata;
        if (u) {
          const cached = u.cachedContentTokenCount ?? 0;
          const prompt = (u.promptTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0);
          usage = {
            type: 'usage',
            inputTokens: Math.max(0, prompt - cached),
            // Thinking tokens are billed as output.
            outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
            cachedInputTokens: cached,
          };
        }
      }
    } catch (err) {
      if (isAbortError(err, signal)) {
        yield usage ?? estimatedUsage(req, text);
        yield { type: 'done', stopReason: 'cancelled' };
        return;
      }
      if (text) yield usage ?? estimatedUsage(req, text);
      yield toErrorChunk('Gemini', err);
      return;
    }
    yield usage ?? estimatedUsage(req, text);
    // Some SDKs end the iteration quietly instead of throwing when aborted.
    yield { type: 'done', stopReason: signal?.aborted ? 'cancelled' : stopReason };
  }
}
