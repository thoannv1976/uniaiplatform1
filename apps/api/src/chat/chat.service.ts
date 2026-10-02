import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { LLMProvider, ChatMessage as ProviderMessage } from '@uniai/ai-providers';
import type { ConversationStore, DepartmentStore, UsageStore } from '@uniai/firestore';
import {
  DEFAULT_SYSTEM_PROMPT,
  formatSseEvent,
  tokenCost,
  usageCost,
  type ChatRequest,
  type ChatStreamEvent,
  type ChatUsage,
  type MessageStatus,
  type UserProfile,
} from '@uniai/shared';
import type { Response } from 'express';
import { ProviderRuntime, ProviderUnavailableError } from '../ai/provider-runtime.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DEPARTMENT_STORE } from '../departments/departments.controller.js';
import { ModelRouter } from './model-router.js';

export const CONVERSATION_STORE = Symbol('CONVERSATION_STORE');
export const USAGE_STORE = Symbol('USAGE_STORE');

/** Upper bound for one answer; the model's own limit applies when lower. */
const MAX_OUTPUT_TOKENS = 16_000;
/** History sent to the model: about this many characters per context-window token. */
const HISTORY_CHARS_PER_TOKEN = 2;
const HISTORY_MAX_CHARS = 400_000;
/** Keeps proxies from closing a quiet stream (e.g. while a model is thinking). */
const HEARTBEAT_MS = 15_000;

const USER_ERRORS: Record<string, string> = {
  rate_limited: 'Nhà cung cấp AI đang quá tải hoặc hết hạn mức. Vui lòng thử lại sau ít phút.',
  unavailable: 'Không kết nối được nhà cung cấp AI. Vui lòng thử lại.',
  timeout: 'Nhà cung cấp AI phản hồi quá lâu. Vui lòng thử lại.',
  auth: 'Cấu hình nhà cung cấp AI chưa đúng. Vui lòng báo quản trị viên.',
  not_found: 'Model AI không còn khả dụng. Vui lòng báo quản trị viên.',
  invalid_request: 'Yêu cầu không hợp lệ với model này (có thể quá dài).',
};

/** Builds the provider conversation: system prompt, recent history within budget, new message. */
export function buildMessages(
  history: { role: 'user' | 'assistant'; content: string }[],
  message: string,
  budgetChars: number,
): ProviderMessage[] {
  const kept: { role: 'user' | 'assistant'; content: string }[] = [];
  let used = message.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (used + m.content.length > budgetChars) break;
    used += m.content.length;
    kept.unshift(m);
  }
  // Providers expect the conversation to start with the user and to alternate roles.
  while (kept[0]?.role === 'assistant') kept.shift();
  const merged: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of [...kept, { role: 'user' as const, content: message }]) {
    const last = merged.at(-1);
    if (last?.role === m.role) last.content += `\n\n${m.content}`;
    else merged.push({ ...m });
  }
  return [{ role: 'system', content: DEFAULT_SYSTEM_PROMPT }, ...merged];
}

/**
 * The AI Gateway's chat path (spec 5.2): route → resolve provider → store the turn →
 * stream SSE → settle the cost in the ledger, also when the user cancels.
 * Quota reservation (M7) and fallback (M10) plug in around `stream`; DLP comes in phase 2.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger('Chat');

  constructor(
    private readonly router: ModelRouter,
    private readonly runtime: ProviderRuntime,
    @Inject(CONVERSATION_STORE) private readonly conversations: ConversationStore,
    @Inject(USAGE_STORE) private readonly usage: UsageStore,
    @Inject(DEPARTMENT_STORE) private readonly departments: DepartmentStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Validation errors are thrown before any byte is sent (normal JSON error responses). */
  async chat(user: UserProfile, req: ChatRequest, res: Response): Promise<void> {
    const requestTime = new Date();
    const route = await this.router.choose(req.model, user.role);
    let provider: LLMProvider;
    try {
      provider = await this.runtime.resolve(route.provider);
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        throw new ServiceUnavailableException(
          `${route.model.displayName} tạm thời không dùng được.`,
        );
      }
      throw err;
    }
    const price = route.model.currentPrice!;
    const turn = await this.conversations.startTurn({
      ownerUid: user.uid,
      conversationId: req.conversationId ?? null,
      userText: req.message,
      modelId: route.model.id,
      providerId: route.model.providerId,
      retentionDays: this.config.conversationRetentionDays,
    });
    if (!turn) throw new NotFoundException('Không tìm thấy hội thoại.');

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const controller = new AbortController();
    let finished = false;
    res.on('close', () => {
      if (!finished) controller.abort();
    });
    const send = (event: ChatStreamEvent) => {
      if (!res.destroyed && !res.writableEnded) res.write(formatSseEvent(event));
    };
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n');
    }, HEARTBEAT_MS);

    send({
      type: 'meta',
      conversationId: turn.conversationId,
      userMessageId: turn.userMessageId,
      messageId: turn.messageId,
      model: {
        id: route.model.id,
        displayName: route.model.displayName,
        providerId: route.model.providerId,
        tier: route.model.tier,
      },
      routeReason: route.reason,
    });

    let text = '';
    let usage: ChatUsage | null = null;
    let stopReason: string | null = null;
    let error: { code: string; message: string } | null = null;
    try {
      const messages = buildMessages(
        turn.history,
        req.message,
        Math.min(route.model.contextWindow * HISTORY_CHARS_PER_TOKEN, HISTORY_MAX_CHARS),
      );
      const stream = provider.stream(
        {
          model: route.model.apiModelId,
          messages,
          maxOutputTokens: Math.min(route.model.maxOutputTokens, MAX_OUTPUT_TOKENS),
          reasoningEffort: route.model.defaultParams.reasoningEffort,
        },
        controller.signal,
      );
      // The user may already have left while the turn was being stored: nothing was sent
      // to the provider, so there is nothing to bill.
      if (controller.signal.aborted) {
        stopReason = 'cancelled';
      } else {
        for await (const chunk of stream) {
          if (chunk.type === 'text') {
            text += chunk.delta;
            send({ type: 'delta', text: chunk.delta });
          } else if (chunk.type === 'usage') {
            usage = {
              inputTokens: chunk.inputTokens,
              outputTokens: chunk.outputTokens,
              cachedInputTokens: chunk.cachedInputTokens,
            };
          } else if (chunk.type === 'done') {
            stopReason = chunk.stopReason;
          } else {
            this.logger.warn(
              JSON.stringify({
                event: 'provider_error',
                model: route.model.id,
                code: chunk.code,
                detail: chunk.message,
              }),
            );
            error = {
              code: chunk.code,
              message: USER_ERRORS[chunk.code] ?? 'Đã có lỗi khi gọi AI.',
            };
          }
        }
      }
    } catch (err) {
      // Adapters never throw; this only guards against bugs so the turn is still settled.
      this.logger.error(`Lỗi gateway: ${String(err)}`);
      error = { code: 'unknown', message: 'Đã có lỗi khi gọi AI.' };
    } finally {
      clearInterval(heartbeat);
    }

    const status: Exclude<MessageStatus, 'streaming'> = error
      ? 'error'
      : stopReason === 'cancelled'
        ? 'cancelled'
        : 'complete';
    const cost = usage ? usageCost(usage, price) : null;
    const responseTime = new Date();
    const latencyMs = responseTime.getTime() - requestTime.getTime();

    // Settle even when the user cancelled: the ledger is the source of truth for cost.
    if (usage && cost !== null) {
      try {
        const department = user.departmentId ? await this.departments.get(user.departmentId) : null;
        await this.usage.record({
          uid: user.uid,
          departmentId: user.departmentId,
          departmentPath: department?.path ?? [],
          appClientId: null,
          providerId: route.model.providerId,
          transport: provider.transport,
          modelId: route.model.id,
          apiModelId: route.model.apiModelId,
          priceId: price.id,
          usage,
          costInput: tokenCost(usage.inputTokens, price.inputPerMTok),
          costCachedInput: tokenCost(
            usage.cachedInputTokens,
            price.cachedInputPerMTok ?? price.inputPerMTok,
          ),
          costOutput: tokenCost(usage.outputTokens, price.outputPerMTok),
          totalCost: cost,
          reservedCost: 0,
          conversationId: turn.conversationId,
          messageId: turn.messageId,
          routeReason: route.reason,
          fallbackFrom: null,
          outcome: status === 'cancelled' ? 'cancelled' : status === 'error' ? 'error' : 'complete',
          requestTime,
          responseTime,
          latencyMs,
        });
      } catch (err) {
        this.logger.error(`Không ghi được sổ cái cho tin nhắn ${turn.messageId}: ${String(err)}`);
      }
    }
    try {
      await this.conversations.finishTurn(turn.conversationId, turn.messageId, {
        content: text,
        status,
        usage,
        cost,
        stopReason,
        error,
        latencyMs,
      });
    } catch (err) {
      // E.g. the user deleted the conversation while the answer was streaming.
      this.logger.warn(`Không lưu được câu trả lời ${turn.messageId}: ${String(err)}`);
    }

    finished = true;
    if (error) send({ type: 'error', code: error.code, message: error.message });
    send({ type: 'done', messageId: turn.messageId, status, stopReason, usage, cost, latencyMs });
    if (!res.writableEnded) res.end();
  }
}
