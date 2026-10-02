import type { ChatChunk, LLMProvider, NormalizedChatRequest, StopReason } from './types.js';

export interface ProbeResult {
  text: string;
  stopReason: StopReason | null;
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null;
  error: { code: string; message: string } | null;
  latencyMs: number;
}

/** Runs one request to completion and collects the result (admin "test model", smoke script). */
export async function probe(
  provider: LLMProvider,
  req: NormalizedChatRequest,
  timeoutMs = 60_000,
): Promise<ProbeResult> {
  const started = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);
  const result: ProbeResult = {
    text: '',
    stopReason: null,
    usage: null,
    error: null,
    latencyMs: 0,
  };
  for await (const chunk of provider.stream(req, signal) as AsyncIterable<ChatChunk>) {
    if (chunk.type === 'text') result.text += chunk.delta;
    else if (chunk.type === 'usage') {
      result.usage = {
        inputTokens: chunk.inputTokens,
        outputTokens: chunk.outputTokens,
        cachedInputTokens: chunk.cachedInputTokens,
      };
    } else if (chunk.type === 'done') result.stopReason = chunk.stopReason;
    else result.error = { code: chunk.code, message: chunk.message };
  }
  if (result.stopReason === 'cancelled' && signal.aborted) {
    result.error = { code: 'timeout', message: `Không có phản hồi sau ${timeoutMs / 1000} giây` };
  }
  result.latencyMs = Date.now() - started;
  return result;
}
