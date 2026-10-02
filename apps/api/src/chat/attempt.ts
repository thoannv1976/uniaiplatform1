import type { Logger } from '@nestjs/common';
import type { ChatMessage as ProviderMessage, LLMProvider } from '@uniai/ai-providers';
import type { ChatUsage, ModelView } from '@uniai/shared';

/** Messages shown to users when a provider fails (never the provider's own text). */
export const USER_ERRORS: Record<string, string> = {
  rate_limited: 'Nhà cung cấp AI đang quá tải hoặc hết hạn mức. Vui lòng thử lại sau ít phút.',
  unavailable: 'Không kết nối được nhà cung cấp AI. Vui lòng thử lại.',
  timeout: 'Nhà cung cấp AI phản hồi quá lâu. Vui lòng thử lại.',
  auth: 'Cấu hình nhà cung cấp AI chưa đúng. Vui lòng báo quản trị viên.',
  not_found: 'Model AI không còn khả dụng. Vui lòng báo quản trị viên.',
  invalid_request:
    'Model này từ chối yêu cầu (nội dung quá dài, hoặc tệp/ảnh đính kèm không được model hỗ trợ). Hãy thử model khác hoặc báo quản trị viên.',
};

export interface Attempt {
  text: string;
  usage: ChatUsage | null;
  stopReason: string | null;
  error: { code: string; message: string; retryable: boolean } | null;
}

/**
 * One call to a provider (web chat and Platform API), forwarding text as it arrives.
 * Never throws: failures come back in `error` so the cost is always settled.
 */
export async function runAttempt(
  planned: {
    route: { model: Pick<ModelView, 'id' | 'providerId' | 'apiModelId' | 'defaultParams'> };
    messages: ProviderMessage[];
    maxOutputTokens: number;
  },
  provider: LLMProvider,
  signal: AbortSignal,
  onText: (delta: string) => void,
  logger: Pick<Logger, 'error'>,
): Promise<Attempt> {
  const out: Attempt = { text: '', usage: null, stopReason: null, error: null };
  try {
    const stream = provider.stream(
      {
        model: planned.route.model.apiModelId,
        messages: planned.messages,
        maxOutputTokens: planned.maxOutputTokens,
        reasoningEffort: planned.route.model.defaultParams.reasoningEffort,
      },
      signal,
    );
    // The caller may already have left: nothing was sent to the provider, nothing to bill.
    if (signal.aborted) {
      out.stopReason = 'cancelled';
      return out;
    }
    for await (const chunk of stream) {
      if (chunk.type === 'text') {
        out.text += chunk.delta;
        onText(chunk.delta);
      } else if (chunk.type === 'usage') {
        out.usage = {
          inputTokens: chunk.inputTokens,
          outputTokens: chunk.outputTokens,
          cachedInputTokens: chunk.cachedInputTokens,
        };
      } else if (chunk.type === 'done') {
        out.stopReason = chunk.stopReason;
      } else {
        // Structured line with a severity, so Cloud Logging files it as a warning; the
        // detail is the provider's own message (credentials redacted by the adapter).
        console.log(
          JSON.stringify({
            severity: 'WARNING',
            message: `provider_error ${planned.route.model.id} ${chunk.code}`,
            event: 'provider_error',
            model: planned.route.model.id,
            provider: planned.route.model.providerId,
            code: chunk.code,
            status: chunk.status ?? null,
            detail: chunk.message,
          }),
        );
        out.error = {
          code: chunk.code,
          message: USER_ERRORS[chunk.code] ?? 'Đã có lỗi khi gọi AI.',
          retryable: chunk.retryable,
        };
      }
    }
  } catch (err) {
    // Adapters never throw; this only guards against bugs so the turn is still settled.
    logger.error(`Lỗi gateway: ${String(err)}`);
    out.error = { code: 'unknown', message: 'Đã có lỗi khi gọi AI.', retryable: false };
  }
  return out;
}
