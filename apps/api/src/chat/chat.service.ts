import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  IMAGE_TOKEN_ESTIMATE,
  type ChatMessage as ProviderMessage,
  type ImageInput,
  type LLMProvider,
} from '@uniai/ai-providers';
import {
  QuotaError,
  type AlertService,
  type ConversationStore,
  type HistoryMessage,
  type ProjectStore,
  type QuotaService,
  type Reservation,
} from '@uniai/firestore';
import {
  CHAT_MODEL_AUTO,
  createUnmasker,
  DEFAULT_SYSTEM_PROMPT,
  FILE_KIND_LABELS_VI,
  formatSseEvent,
  isPremiumTier,
  tokenCost,
  usageCost,
  type ChatRequest,
  type ChatStreamEvent,
  type ChatUsage,
  type Citation,
  type RouteInput,
  type MessageStatus,
  type Price,
  type UserProfile,
  unmaskText,
} from '@uniai/shared';
import type { Response } from 'express';
import { ProviderRuntime, ProviderUnavailableError } from '../ai/provider-runtime.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { AuditService } from '../audit/audit.service.js';
import { DlpService, type DlpOutcome } from '../dlp/dlp.service.js';
import { FilesService, type LoadedAttachment } from '../files/files.service.js';
import { KnowledgeRetrieval } from '../knowledge/retrieval.service.js';
import { PROJECT_STORE } from '../workspace/tokens.js';
import { CircuitBreaker } from '../resilience/circuit-breaker.js';
import { RouterService } from '../router/router.service.js';
import { ALERTS } from '../usage/tokens.js';
import { ModelRouter, type Route } from './model-router.js';

export const CONVERSATION_STORE = Symbol('CONVERSATION_STORE');
export const QUOTA_SERVICE = Symbol('QUOTA_SERVICE');

/** Upper bound for one answer; the model's own limit applies when lower. */
const MAX_OUTPUT_TOKENS = 16_000;
/** History sent to the model: about this many characters per context-window token. */
const HISTORY_CHARS_PER_TOKEN = 2;
const HISTORY_MAX_CHARS = 400_000;
/** Knowledge-base passages per question (~6k tokens). */
const RAG_MAX_CHARS = 24_000;
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
  invalid_request:
    'Model này từ chối yêu cầu (nội dung quá dài, hoặc tệp/ảnh đính kèm không được model hỗ trợ). Hãy thử model khác hoặc báo quản trị viên.',
};

type Turn = { role: 'user' | 'assistant'; content: string; images?: ImageInput[] };

/** Builds the provider conversation: system prompt, recent history within budget, new message. */
export function buildMessages(
  history: Turn[],
  message: string | Omit<Turn, 'role'>,
  budgetChars: number,
  system: string = DEFAULT_SYSTEM_PROMPT,
): ProviderMessage[] {
  const next: Turn =
    typeof message === 'string' ? { role: 'user', content: message } : { role: 'user', ...message };
  const kept: Turn[] = [];
  let used = next.content.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (used + m.content.length > budgetChars) break;
    used += m.content.length;
    kept.unshift(m);
  }
  // Providers expect the conversation to start with the user and to alternate roles.
  while (kept[0]?.role === 'assistant') kept.shift();
  const merged: Turn[] = [];
  for (const m of [...kept, next]) {
    const last = merged.at(-1);
    if (last?.role === m.role) {
      last.content += `\n\n${m.content}`;
      if (m.images?.length) last.images = [...(last.images ?? []), ...m.images];
    } else merged.push({ ...m });
  }
  return [
    { role: 'system', content: system },
    ...merged.map((m) => (m.images?.length ? m : { role: m.role, content: m.content })),
  ];
}

/**
 * A user message with its attachments: each document's text in a <tệp> block (cut to fit
 * `capChars` in total), images passed separately when the model reads images.
 */
export function withAttachments(
  text: string,
  files: LoadedAttachment[],
  capChars: number,
  vision: boolean,
): Omit<Turn, 'role'> {
  if (files.length === 0) return { content: text };
  const docs = files.filter((f) => f.text !== null);
  // Share the room fairly: short documents keep everything, long ones split the rest.
  const share = new Map<string, number>();
  let room = Math.max(0, capChars);
  const bySize = [...docs].sort((a, b) => a.text!.length - b.text!.length);
  bySize.forEach((f, i) => {
    const fair = Math.floor(room / (bySize.length - i));
    const take = Math.min(f.text!.length, fair);
    share.set(f.ref.id, take);
    room -= take;
  });
  const blocks: string[] = [];
  const images: ImageInput[] = [];
  for (const f of files) {
    const label = `${f.ref.name} (${FILE_KIND_LABELS_VI[f.ref.kind]})`;
    if (!f.available) {
      blocks.push(`[Tệp ${label} không còn được lưu trữ.]`);
    } else if (f.image) {
      if (vision) images.push(f.image);
      else blocks.push(`[Ảnh ${f.ref.name}: model này không đọc được ảnh.]`);
    } else {
      const keep = share.get(f.ref.id) ?? 0;
      const cut = keep < f.text!.length || f.truncated;
      blocks.push(
        `<tệp tên="${f.ref.name.replace(/"/g, "'")}">\n${f.text!.slice(0, keep)}${cut ? '\n[… phần còn lại của tệp đã được cắt bớt do giới hạn độ dài]' : ''}\n</tệp>`,
      );
    }
  }
  return {
    content: `${blocks.join('\n\n')}\n\n${text}`,
    ...(images.length ? { images } : {}),
  };
}

/** System prompt of a conversation in a project: instructions and project files (M14). */
export function projectSystemPrompt(
  project: { name: string; instructions: string },
  files: LoadedAttachment[],
  capChars: number,
): string {
  const parts = [DEFAULT_SYSTEM_PROMPT, `Bạn đang làm việc trong dự án "${project.name}".`];
  if (project.instructions) parts.push(`Chỉ dẫn của dự án:\n${project.instructions}`);
  const docs = files.filter((f) => f.text !== null);
  if (docs.length) {
    parts.push(`Tài liệu của dự án:\n${withAttachments('', docs, capChars, false).content.trim()}`);
  }
  return parts.join('\n\n');
}

/** Conservative input estimate: about 3 characters per token, plus per-message overhead. */
export function estimateInputTokens(messages: ProviderMessage[]): number {
  return messages.reduce(
    (sum, m) =>
      sum + Math.ceil(m.content.length / 3) + 8 + (m.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE,
    0,
  );
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
 * A provider failing before any text is replaced once by an equivalent model (fallback,
 * spec 8.8). DLP (spec 8.11) checks what the user adds before anything is stored or sent.
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
    private readonly files: FilesService,
    private readonly circuit: CircuitBreaker,
    private readonly audit: AuditService,
    private readonly smartRouter: RouterService,
    private readonly retrieval: KnowledgeRetrieval,
    @Inject(PROJECT_STORE) private readonly projects: ProjectStore,
    private readonly dlp: DlpService,
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

  /** Reserves the worst-case cost of `r` for the messages built for it. */
  private async plan(
    user: UserProfile,
    r: Route,
    build: (route: Route) => ProviderMessage[],
    conversationId: string | null,
    fallbackFrom: string | null = null,
  ): Promise<Planned> {
    const messages = build(r);
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
      conversationId,
      routeReason: r.reason,
      fallbackFrom,
      modelRateLimit: r.model.rateLimitPerMinute,
    });
    return { route: r, reservation, maxOutputTokens: cost.maxOutputTokens, messages };
  }

  /**
   * Picks the route and reserves its worst-case cost. A model choice that would exceed the
   * premium budget falls back to AUTO (cheaper models), as spec 8.6 asks.
   */
  private async reserve(
    user: UserProfile,
    req: ChatRequest,
    build: (route: Route) => ProviderMessage[],
    routeInput: RouteInput,
  ): Promise<Planned> {
    const requireImage = routeInput.imageCount > 0;
    const decision =
      req.model === CHAT_MODEL_AUTO ? await this.smartRouter.decide(routeInput) : undefined;
    const route = await this.router.choose(req.model, user.role, { requireImage, decision });
    const conversationId = req.conversationId ?? null;
    try {
      return await this.plan(user, route, build, conversationId);
    } catch (err) {
      if (!(err instanceof QuotaError && err.code === 'premium_exceeded')) throw err;
      // Out of premium (Advanced/Premium) budget: drop to the cheaper tiers (spec 8.6).
      const auto = await this.router
        .choose(CHAT_MODEL_AUTO, user.role, {
          excludePremium: true,
          requireImage,
          decision: decision ?? (await this.smartRouter.decide(routeInput)),
        })
        .catch(() => {
          throw err; // no cheaper model: keep the premium-quota message
        });
      return this.plan(
        user,
        {
          ...auto,
          reason: `Hết hạn mức model Nâng cao/Cao cấp – hạ xuống ${auto.model.displayName}`,
        },
        build,
        conversationId,
      );
    }
  }

  /** Contents of the files attached to earlier messages, looked up per message. */
  private async loadHistoryFiles(uid: string, history: HistoryMessage[]) {
    const refs = history.flatMap((m) => m.attachments);
    const loaded = refs.length ? await this.files.forHistory(uid, refs) : [];
    const byId = new Map(loaded.map((f) => [f.ref.id, f]));
    return (m: HistoryMessage) => m.attachments.flatMap((a) => byId.get(a.id) ?? []);
  }

  /** Validation and quota errors are thrown before any byte is sent (JSON error responses). */
  async chat(user: UserProfile, req: ChatRequest, res: Response): Promise<void> {
    const requestTime = new Date();
    const history = req.conversationId
      ? await this.conversations.history(req.conversationId, user.uid)
      : [];
    if (!history) throw new NotFoundException('Không tìm thấy hội thoại.');
    // Project (M14): instructions and files of the conversation's project.
    const projectId = req.conversationId
      ? ((await this.conversations.get(req.conversationId, user.uid))?.projectId ?? null)
      : (req.projectId ?? null);
    const project = projectId ? await this.projects.get(projectId, user.uid) : null;
    if (projectId && !project && !req.conversationId) {
      throw new NotFoundException('Không tìm thấy dự án.');
    }
    const projectFiles = project?.fileIds.length
      ? await this.files.forProject(user.uid, project.fileIds)
      : [];
    const attachedRaw = req.fileIds?.length
      ? await this.files.forMessage(user.uid, req.fileIds)
      : [];
    // DLP (M15): blocks (422) or asks for confirmation (428) before anything is stored,
    // reserved or sent; values the policy masks become placeholders in every part of the
    // prompt, history included.
    const dlp = await this.dlp.check(
      user,
      [
        req.message,
        ...attachedRaw.flatMap((f) => (f.text ? [f.text] : [])),
        ...(project ? [project.instructions] : []),
        ...projectFiles.flatMap((f) => (f.text ? [f.text] : [])),
      ],
      req.dlpAcknowledged === true,
    );
    const maskFile = (f: LoadedAttachment): LoadedAttachment =>
      f.text === null ? f : { ...f, text: dlp.apply(f.text) };
    const attached = attachedRaw.map(maskFile);
    const projectDocs = projectFiles.map(maskFile);
    const projectPrompt = project
      ? { name: project.name, instructions: dlp.apply(project.instructions) }
      : null;
    const message = dlp.apply(req.message);
    // RAG (M13): passages from the selected knowledge bases go before the question.
    const rag = req.knowledgeBaseIds?.length
      ? await this.retrieval.retrieve(user, req.knowledgeBaseIds, message, RAG_MAX_CHARS)
      : { citations: [], context: '' };
    const question = rag.context ? `${rag.context}\n${message}` : message;
    const earlierFiles = await this.loadHistoryFiles(user.uid, history);
    const earlier = (m: HistoryMessage) => earlierFiles(m).map(maskFile);
    // Files make prompts long: the route's context window decides how much of them fits.
    const build = (r: Route) => {
      const budget = Math.min(r.model.contextWindow * HISTORY_CHARS_PER_TOKEN, HISTORY_MAX_CHARS);
      const vision = r.model.capabilities.includes('image');
      const turns = history.map((m) => ({
        role: m.role,
        ...withAttachments(dlp.apply(m.content), earlier(m), Math.floor(budget / 4), vision),
      }));
      const next = withAttachments(question, attached, budget - question.length, vision);
      const system = projectPrompt
        ? projectSystemPrompt(projectPrompt, projectDocs, Math.floor(budget / 4))
        : DEFAULT_SYSTEM_PROMPT;
      return buildMessages(turns, next, budget, system);
    };
    const requireImage = attached.some((f) => f.image !== null);
    const first = await this.reserve(user, req, build, {
      text: req.message,
      documentCount: attached.filter((f) => f.image === null).length,
      imageCount: attached.filter((f) => f.image !== null).length,
      attachedChars: attached.reduce((n, f) => n + (f.text?.length ?? 0), 0),
    });

    let provider: LLMProvider;
    let turn;
    try {
      provider = await this.resolve(first.route);
      turn = await this.conversations.startTurn({
        ownerUid: user.uid,
        conversationId: req.conversationId ?? null,
        userText: req.message,
        attachments: attached.map((f) => f.ref),
        ...(req.knowledgeBaseIds ? { knowledgeBaseIds: req.knowledgeBaseIds } : {}),
        projectId: project?.id ?? null,
        modelId: first.route.model.id,
        providerId: first.route.model.providerId,
        retentionDays: this.config.conversationRetentionDays,
      });
      if (!turn) throw new NotFoundException('Không tìm thấy hội thoại.');
    } catch (err) {
      await this.quota.release(first.reservation).catch(() => undefined);
      throw err;
    }
    await this.stream(
      {
        user,
        req,
        build,
        requireImage,
        turn,
        requestTime,
        res,
        citations: rag.citations,
        dlp,
        unmask: createUnmasker(dlp.mapping),
      },
      first,
      provider,
    );
  }

  /** One call to a provider, forwarding text to the browser as it arrives. */
  private async attempt(
    planned: Planned,
    provider: LLMProvider,
    signal: AbortSignal,
    onText: (delta: string) => void,
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
      // The user may already have left while the turn was being stored: nothing was sent
      // to the provider, so there is nothing to bill.
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
      this.logger.error(`Lỗi gateway: ${String(err)}`);
      out.error = { code: 'unknown', message: 'Đã có lỗi khi gọi AI.', retryable: false };
    }
    return out;
  }

  /** Commits the tokens of an attempt to the ledger (or releases the reservation). */
  private async settle(
    user: UserProfile,
    planned: Planned,
    result: Attempt,
    status: Exclude<MessageStatus, 'streaming'>,
    turn: { conversationId: string; messageId: string },
    latencyMs: number,
    responseTime: Date,
  ): Promise<number | null> {
    const price = planned.route.model.currentPrice!;
    const { usage } = result;
    const cost = usage ? usageCost(usage, price) : null;
    // Settle even when the user cancelled: the ledger is the source of truth for cost.
    try {
      if (usage && cost !== null) {
        const after = await this.quota.commit(planned.reservation, {
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
            .checkUser(
              user.uid,
              planned.reservation.period,
              after.used - cost,
              after.used,
              after.limit,
            )
            .catch((err: unknown) =>
              this.logger.warn(`Không gửi được cảnh báo định mức: ${String(err)}`),
            );
        }
      } else {
        await this.quota.release(planned.reservation);
      }
    } catch (err) {
      // The sweeper releases the reservation; a missing commit is logged for reconciliation.
      this.logger.error(
        JSON.stringify({
          event: 'settle_failed',
          uid: user.uid,
          txnId: planned.reservation.txnId,
          cost,
          detail: String(err),
        }),
      );
    }
    return cost;
  }

  private async stream(ctx: StreamContext, first: Planned, firstProvider: LLMProvider) {
    const { user, turn, res, requestTime } = ctx;
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
    const sendMeta = (route: Route) =>
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
    sendMeta(first.route);
    if (ctx.citations.length) send({ type: 'citations', citations: ctx.citations });
    const { decision } = ctx.dlp;
    const masked = (decision.byAction.mask ?? []).map((d) => ({
      detector: d,
      count: decision.counts[d] ?? 0,
    }));
    const acknowledged = decision.byAction.warn ?? [];
    if (masked.length || acknowledged.length) {
      send({ type: 'dlp', masked, acknowledged });
      this.dlp.record(
        user,
        acknowledged.length ? 'warn' : 'mask',
        decision,
        'sent',
        `conversations/${turn.conversationId}/messages/${turn.userMessageId}`,
      );
    }
    if (first.route.reason !== 'Người dùng chọn model') {
      this.auditQuietly('MODEL_ROUTED', user.uid, turn, {
        model: first.route.model.id,
        reason: first.route.reason,
      });
    }

    let planned = first;
    let provider = firstProvider;
    let fellBack = false;
    let result: Attempt;
    let status: Exclude<MessageStatus, 'streaming'>;
    try {
      for (;;) {
        result = await this.attempt(planned, provider, controller.signal, (delta) => {
          // Placeholders ([CCCD_1]…) go back to the values the user typed.
          const text = ctx.unmask.push(delta);
          if (text) send({ type: 'delta', text });
        });
        const providerId = planned.route.model.providerId;
        if (result.error?.retryable) this.circuit.failure(providerId);
        else if (!result.error) this.circuit.success(providerId);
        if (result.error) {
          this.auditQuietly('API_ERROR', user.uid, turn, {
            model: planned.route.model.id,
            provider: providerId,
            code: result.error.code,
          });
        }
        status = result.error
          ? 'error'
          : result.stopReason === 'cancelled'
            ? 'cancelled'
            : 'complete';

        // Fallback (spec 8.8): retryable error or refusal, once, only before any text.
        const canFallBack =
          !fellBack &&
          result.text === '' &&
          !controller.signal.aborted &&
          (result.error?.retryable === true || result.stopReason === 'refusal');
        const next = canFallBack
          ? await this.router
              .fallback(planned.route, user.role, { requireImage: ctx.requireImage })
              .catch(() => null)
          : null;
        if (!next) break;

        const now = new Date();
        await this.settle(
          user,
          planned,
          result,
          result.error ? 'error' : 'complete',
          turn,
          now.getTime() - requestTime.getTime(),
          now,
        );
        const failedModel = planned.route.model.id;
        let replacement: { planned: Planned; provider: LLMProvider } | null = null;
        try {
          const p = await this.plan(user, next, ctx.build, turn.conversationId, failedModel);
          try {
            replacement = { planned: p, provider: await this.resolve(next) };
          } catch (err) {
            await this.quota.release(p.reservation).catch(() => undefined);
            throw err;
          }
        } catch (err) {
          this.logger.warn(`Không chuyển được sang model dự phòng: ${String(err)}`);
        }
        if (!replacement) {
          // The failed attempt is already settled: report it as is.
          const failedCost = result.usage
            ? usageCost(result.usage, planned.route.model.currentPrice!)
            : null;
          return await this.finish(ctx, planned, result, status, failedCost, send, () => {
            finished = true;
          });
        }
        fellBack = true;
        this.auditQuietly('FALLBACK_USED', user.uid, turn, {
          from: failedModel,
          to: next.model.id,
          code: result.error?.code ?? result.stopReason,
        });
        planned = replacement.planned;
        provider = replacement.provider;
        sendMeta(planned.route);
      }
    } finally {
      clearInterval(heartbeat);
    }

    const responseTime = new Date();
    const cost = await this.settle(
      user,
      planned,
      result,
      status,
      turn,
      responseTime.getTime() - requestTime.getTime(),
      responseTime,
    );
    await this.finish(ctx, planned, result, status, cost, send, () => {
      finished = true;
    });
  }

  /** Stores the answer, writes AI_REQUEST and ends the SSE stream. */
  private async finish(
    ctx: StreamContext,
    planned: Planned,
    result: Attempt,
    status: Exclude<MessageStatus, 'streaming'>,
    cost: number | null,
    send: (e: ChatStreamEvent) => void,
    markFinished: () => void,
  ) {
    const { turn, res } = ctx;
    const latencyMs = Date.now() - ctx.requestTime.getTime();
    const error = result.error ? { code: result.error.code, message: result.error.message } : null;
    try {
      await this.conversations.finishTurn(turn.conversationId, turn.messageId, {
        content: unmaskText(result.text, ctx.dlp.mapping),
        status,
        usage: result.usage,
        cost,
        stopReason: result.stopReason,
        error,
        latencyMs,
        citations: ctx.citations,
        modelId: planned.route.model.id,
        providerId: planned.route.model.providerId,
      });
    } catch (err) {
      // E.g. the user deleted the conversation while the answer was streaming.
      this.logger.warn(`Không lưu được câu trả lời ${turn.messageId}: ${String(err)}`);
    }
    this.auditQuietly('AI_REQUEST', ctx.user.uid, turn, {
      model: planned.route.model.id,
      provider: planned.route.model.providerId,
      status,
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      cachedInputTokens: result.usage?.cachedInputTokens ?? 0,
      cost,
      latencyMs,
    });

    markFinished();
    const rest = ctx.unmask.flush();
    if (rest) send({ type: 'delta', text: rest });
    if (error) send({ type: 'error', code: error.code, message: error.message });
    send({
      type: 'done',
      messageId: turn.messageId,
      status,
      stopReason: result.stopReason,
      usage: result.usage,
      cost,
      latencyMs,
    });
    if (!res.writableEnded) res.end();
  }

  /** Audit entries on the chat path never fail the request; they carry ids, not content. */
  private auditQuietly(
    event: 'AI_REQUEST' | 'MODEL_ROUTED' | 'FALLBACK_USED' | 'API_ERROR',
    uid: string,
    turn: { conversationId: string; messageId: string },
    metadata: Record<string, unknown>,
  ) {
    this.audit.recordQuietly({
      event,
      actor: uid,
      target: `conversations/${turn.conversationId}/messages/${turn.messageId}`,
      metadata,
    });
  }
}

interface Planned {
  route: Route;
  reservation: Reservation;
  maxOutputTokens: number;
  messages: ProviderMessage[];
}

interface Attempt {
  text: string;
  usage: ChatUsage | null;
  stopReason: string | null;
  error: { code: string; message: string; retryable: boolean } | null;
}

interface StreamContext {
  user: UserProfile;
  req: ChatRequest;
  build: (route: Route) => ProviderMessage[];
  requireImage: boolean;
  turn: { conversationId: string; userMessageId: string; messageId: string };
  requestTime: Date;
  res: Response;
  /** Knowledge-base passages given to the model (M13). */
  citations: Citation[];
  /** DLP outcome of the request and the streaming placeholder restorer (M15). */
  dlp: DlpOutcome;
  unmask: ReturnType<typeof createUnmasker>;
}
