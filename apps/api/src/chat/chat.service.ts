import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { LLMProvider, ChatMessage as ProviderMessage } from '@uniai/ai-providers';
import {
  QuotaError,
  type AlertService,
  type ConversationStore,
  type QuotaService,
  type Reservation,
} from '@uniai/firestore';
import {
  CHAT_MODEL_AUTO,
  DEFAULT_SYSTEM_PROMPT,
  formatSseEvent,
  isPremiumTier,
  tokenCost,
  usageCost,
  type ChatRequest,
  type ChatStreamEvent,
  type ChatUsage,
  type MessageStatus,
  type Price,
  type UserProfile,
} from '@uniai/shared';
import type { Response } from 'express';
import { ProviderRuntime, ProviderUnavailableError } from '../ai/provider-runtime.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ALERTS } from '../usage/tokens.js';
import { ModelRouter, type Route } from './model-router.js';

export const CONVERSATION_STORE = Symbol('CONVERSATION_STORE');
export const QUOTA_SERVICE = Symbol('QUOTA_SERVICE');

/** Upper bound for one answer; the model's own limit applies when lower. */
const MAX_OUTPUT_TOKENS = 16_000;
/** History sent to the model: about this many characters per context-window token. */
const HISTORY_CHARS_PER_TOKEN = 2;
const HISTORY_MAX_CHARS = 400_000;
/** Keeps proxies from closing a quiet stream (e.g. while a model is thinking). */
const HEARTBEAT_MS = 15_000;
/** Answers are not shortened below this to fit a small remaining quota. */
const MIN_OUTPUT_TOKENS = 1024;

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

/** Conservative input estimate: about 3 characters per token, plus per-message overhead. */
export function estimateInputTokens(messages: ProviderMessage[]): number {
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 3) + 8, 0);
}

/**
 * Worst-case cost (spec 8.7: input estimate + max output) and the output cap, lowered when
 * that lets the request fit what is left of the user's quota.
 */
export function planCost(
  inputTokens: number,
  maxOutputTokens: number,
  price: Pick<Price, 'inputPerMTok' | 'outputPerMTok'>,
  room: number | null,
): { estimate: number; maxOutputTokens: number } {
  const inputCost = tokenCost(inputTokens, price.inputPerMTok);
  let out = maxOutputTokens;
  if (room !== null && price.outputPerMTok > 0) {
    const fit = Math.floor(((room - inputCost) * 1_000_000) / price.outputPerMTok);
    out = Math.max(MIN_OUTPUT_TOKENS, Math.min(out, fit));
  }
  return { estimate: inputCost + tokenCost(out, price.outputPerMTok), maxOutputTokens: out };
}

/**
 * The AI Gateway's chat path (spec 5.2): route → resolve provider → reserve quota → store
 * the turn → stream SSE → settle the real cost (also when the user cancels).
 * Fallback (M10) plugs in around `stream`; DLP comes in phase 2.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger('Chat');

  constructor(
    private readonly router: ModelRouter,
    private readonly runtime: ProviderRuntime,
    @Inject(CONVERSATION_STORE) private readonly conversations: ConversationStore,
    @Inject(QUOTA_SERVICE) private readonly quota: QuotaService,
    @Inject(ALERTS) private readonly alerts: AlertService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private async resolve(route: Route): Promise<LLMProvider> {
    try {
      return await this.runtime.resolve(route.provider);
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        throw new ServiceUnavailableException(
          `${route.model.displayName} tạm thời không dùng được.`,
        );
      }
      throw err;
    }
  }

  /**
   * Picks the route and reserves its worst-case cost. A model choice that would exceed the
   * premium budget falls back to AUTO (cheaper models), as spec 8.6 asks.
   */
  private async reserve(user: UserProfile, req: ChatRequest, messages: ProviderMessage[]) {
    const route = await this.router.choose(req.model, user.role);
    const plan = async (r: Route) => {
      const premium = isPremiumTier(r.model.tier);
      const summary = await this.quota.summary(user.uid);
      const room = summary
        ? premium
          ? Math.min(summary.remaining, summary.premiumRemaining)
          : summary.remaining
        : null;
      const cost = planCost(
        estimateInputTokens(messages),
        Math.min(r.model.maxOutputTokens, MAX_OUTPUT_TOKENS),
        r.model.currentPrice!,
        room,
      );
      const reservation = await this.quota.reserve({
        uid: user.uid,
        estimate: cost.estimate,
        premium,
        providerId: r.model.providerId,
        transport: r.provider.transport,
        modelId: r.model.id,
        modelTier: r.model.tier,
        apiModelId: r.model.apiModelId,
        priceId: r.model.currentPrice!.id,
        conversationId: req.conversationId ?? null,
        routeReason: r.reason,
      });
      return { route: r, reservation, maxOutputTokens: cost.maxOutputTokens };
    };
    try {
      return await plan(route);
    } catch (err) {
      if (
        !(err instanceof QuotaError && err.code === 'premium_exceeded') ||
        req.model === CHAT_MODEL_AUTO
      ) {
        throw err;
      }
      const auto = await this.router
        .choose(CHAT_MODEL_AUTO, user.role, { excludePremium: true })
        .catch(() => {
          throw err; // no cheaper model: keep the premium-quota message
        });
      return plan({
        ...auto,
        reason: `Hết hạn mức model cao cấp – chuyển sang ${auto.model.displayName}`,
      });
    }
  }

  /** Validation and quota errors are thrown before any byte is sent (JSON error responses). */
  async chat(user: UserProfile, req: ChatRequest, res: Response): Promise<void> {
    const requestTime = new Date();
    const history = req.conversationId
      ? await this.conversations.history(req.conversationId, user.uid)
      : [];
    if (!history) throw new NotFoundException('Không tìm thấy hội thoại.');
    // The route's context window only trims history; reserve with a generous budget first.
    const draft = buildMessages(history, req.message, HISTORY_MAX_CHARS);
    const { route, reservation, maxOutputTokens } = await this.reserve(user, req, draft);
    const messages = buildMessages(
      history,
      req.message,
      Math.min(route.model.contextWindow * HISTORY_CHARS_PER_TOKEN, HISTORY_MAX_CHARS),
    );

    let provider: LLMProvider;
    let turn;
    try {
      provider = await this.resolve(route);
      turn = await this.conversations.startTurn({
        ownerUid: user.uid,
        conversationId: req.conversationId ?? null,
        userText: req.message,
        modelId: route.model.id,
        providerId: route.model.providerId,
        retentionDays: this.config.conversationRetentionDays,
      });
      if (!turn) throw new NotFoundException('Không tìm thấy hội thoại.');
    } catch (err) {
      await this.quota.release(reservation).catch(() => undefined);
      throw err;
    }
    await this.stream(
      user,
      route,
      provider,
      reservation,
      turn,
      messages,
      maxOutputTokens,
      requestTime,
      res,
    );
  }

  private async stream(
    user: UserProfile,
    route: Route,
    provider: LLMProvider,
    reservation: Reservation,
    turn: { conversationId: string; userMessageId: string; messageId: string },
    messages: ProviderMessage[],
    maxOutputTokens: number,
    requestTime: Date,
    res: Response,
  ): Promise<void> {
    const price = route.model.currentPrice!;
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
      const stream = provider.stream(
        {
          model: route.model.apiModelId,
          messages,
          maxOutputTokens,
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
    try {
      if (usage && cost !== null) {
        const after = await this.quota.commit(reservation, {
          usage,
          costInput: tokenCost(usage.inputTokens, price.inputPerMTok),
          costCachedInput: tokenCost(
            usage.cachedInputTokens,
            price.cachedInputPerMTok ?? price.inputPerMTok,
          ),
          costOutput: tokenCost(usage.outputTokens, price.outputPerMTok),
          totalCost: cost,
          outcome: status,
          messageId: turn.messageId,
          conversationId: turn.conversationId,
          latencyMs,
          responseTime,
        });
        // In-app alert at 80 % of the monthly quota (spec 8.13), checked right after settling.
        if (after) {
          void this.alerts
            .checkUser(user.uid, reservation.period, after.used - cost, after.used, after.limit)
            .catch((err: unknown) =>
              this.logger.warn(`Không gửi được cảnh báo định mức: ${String(err)}`),
            );
        }
      } else {
        await this.quota.release(reservation);
      }
    } catch (err) {
      // The sweeper releases the reservation; a missing commit is logged for reconciliation.
      this.logger.error(
        JSON.stringify({
          event: 'settle_failed',
          uid: user.uid,
          txnId: reservation.txnId,
          cost,
          detail: String(err),
        }),
      );
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
