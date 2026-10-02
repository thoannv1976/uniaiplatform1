import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ChatMessage as ProviderMessage, LLMProvider } from '@uniai/ai-providers';
import type { QuotaService, Reservation } from '@uniai/firestore';
import {
  CHAT_MODEL_AUTO,
  createUnmasker,
  DEFAULT_SYSTEM_PROMPT,
  isPremiumTier,
  tokenCost,
  unmaskText,
  usageCost,
  type PlatformChatRequest,
  type PlatformChatResponse,
  type PlatformStreamEvent,
} from '@uniai/shared';
import type { Response } from 'express';
import { ProviderRuntime, ProviderUnavailableError } from '../ai/provider-runtime.js';
import { AuditService } from '../audit/audit.service.js';
import type { AppContext } from '../auth/auth.guard.js';
import { runAttempt, type Attempt } from '../chat/attempt.js';
import {
  buildMessages,
  estimateInputTokens,
  planCost,
  QUOTA_SERVICE,
} from '../chat/chat.service.js';
import { ModelRouter, type Route } from '../chat/model-router.js';
import { DlpService } from '../dlp/dlp.service.js';
import { CircuitBreaker } from '../resilience/circuit-breaker.js';
import { RouterService } from '../router/router.service.js';

/** Same bounds as the web chat. */
const MAX_OUTPUT_TOKENS = 16_000;
const HISTORY_CHARS_PER_TOKEN = 2;
const HISTORY_MAX_CHARS = 400_000;
const HEARTBEAT_MS = 15_000;
/** Apps are treated like staff with the "user" role for model access and DLP. */
const APP_ROLE = 'user' as const;

interface Planned {
  route: Route;
  reservation: Reservation;
  maxOutputTokens: number;
  messages: ProviderMessage[];
}

const modelInfo = (r: Route) => ({
  id: r.model.id,
  displayName: r.model.displayName,
  providerId: r.model.providerId,
  tier: r.model.tier,
});

/**
 * Platform API chat (M17): stateless – the app sends the conversation it wants answered,
 * nothing is stored but the ledger entry. The same gateway rules as the web chat apply:
 * DLP, Smart Router, kill switch, circuit breaker, one fallback before any text, and the
 * worst case reserved on the app's own budget before the provider is called.
 */
@Injectable()
export class PlatformChatService {
  private readonly logger = new Logger('PlatformChat');

  constructor(
    private readonly router: ModelRouter,
    private readonly runtime: ProviderRuntime,
    @Inject(QUOTA_SERVICE) private readonly quota: QuotaService,
    private readonly circuit: CircuitBreaker,
    private readonly audit: AuditService,
    private readonly smartRouter: RouterService,
    private readonly dlp: DlpService,
  ) {}

  private actor(app: AppContext) {
    return `app:${app.client.id}`;
  }

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

  private async plan(
    app: AppContext,
    req: PlatformChatRequest,
    route: Route,
    build: (r: Route) => ProviderMessage[],
    fallbackFrom: string | null = null,
  ): Promise<Planned> {
    const messages = build(route);
    const usage = await this.quota.appUsage(app.client.id);
    const room = app.client.monthlyBudget - usage.used - usage.reserved;
    const cost = planCost(
      estimateInputTokens(messages),
      Math.min(route.model.maxOutputTokens, req.maxOutputTokens ?? MAX_OUTPUT_TOKENS),
      route.model.currentPrice!,
      room,
    );
    const reservation = await this.quota.reserve({
      uid: this.actor(app),
      appClientId: app.client.id,
      reference: req.reference ?? null,
      estimate: cost.estimate,
      premium: false,
      providerId: route.model.providerId,
      transport: route.provider.transport,
      modelId: route.model.id,
      modelTier: route.model.tier,
      apiModelId: route.model.apiModelId,
      priceId: route.model.currentPrice!.id,
      conversationId: null,
      routeReason: route.reason,
      fallbackFrom,
    });
    return { route, reservation, maxOutputTokens: cost.maxOutputTokens, messages };
  }

  private async settle(planned: Planned, result: Attempt, latencyMs: number) {
    const price = planned.route.model.currentPrice!;
    const { usage } = result;
    const cost = usage ? usageCost(usage, price) : null;
    try {
      if (usage && cost !== null) {
        await this.quota.commit(planned.reservation, {
          usage,
          costInput: tokenCost(usage.inputTokens, price.inputPerMTok),
          costCachedInput: tokenCost(
            usage.cachedInputTokens,
            price.cachedInputPerMTok ?? price.inputPerMTok,
          ),
          costOutput: tokenCost(usage.outputTokens, price.outputPerMTok),
          totalCost: cost,
          outcome: result.error
            ? 'error'
            : result.stopReason === 'cancelled'
              ? 'cancelled'
              : 'complete',
          messageId: null,
          conversationId: null,
          latencyMs,
        });
      } else {
        await this.quota.release(planned.reservation);
      }
    } catch (err) {
      // The sweeper releases the reservation; a missing commit is logged for reconciliation.
      this.logger.error(
        JSON.stringify({
          event: 'settle_failed',
          app: planned.reservation.appClientId,
          txnId: planned.reservation.txnId,
          cost,
          detail: String(err),
        }),
      );
    }
    return cost;
  }

  /** Validation, DLP, routing and quota errors are thrown before any byte is sent. */
  async chat(app: AppContext, req: PlatformChatRequest, res: Response): Promise<void> {
    const started = Date.now();
    const subject = { role: APP_ROLE, departmentPath: app.departmentPath };
    const dlp = await this.dlp.checkFor(
      this.actor(app),
      subject,
      req.messages.map((m) => m.content),
      req.dlpAcknowledged === true,
    );
    const masked = req.messages.map((m) => ({ ...m, content: dlp.apply(m.content) }));
    const system = masked.filter((m) => m.role === 'system').map((m) => m.content);
    const turns = masked.filter((m) => m.role !== 'system') as {
      role: 'user' | 'assistant';
      content: string;
    }[];
    const question = turns.at(-1)!;
    const build = (r: Route) =>
      buildMessages(
        turns.slice(0, -1),
        question.content,
        Math.min(r.model.contextWindow * HISTORY_CHARS_PER_TOKEN, HISTORY_MAX_CHARS),
        system.length ? system.join('\n\n') : DEFAULT_SYSTEM_PROMPT,
      );

    const auto = req.model === CHAT_MODEL_AUTO;
    const decision = auto
      ? await this.smartRouter.decide({
          text: question.content,
          documentCount: 0,
          imageCount: 0,
          attachedChars: turns.slice(0, -1).reduce((n, t) => n + t.content.length, 0),
        })
      : undefined;
    const route = await this.router.choose(req.model, APP_ROLE, {
      decision,
      excludePremium: !app.client.allowAdvanced,
    });
    if (!auto && isPremiumTier(route.model.tier) && !app.client.allowAdvanced) {
      throw new ForbiddenException(
        `Ứng dụng chưa được phép dùng model nhóm Nâng cao/Cao cấp (${route.model.displayName}). Hãy dùng "auto".`,
      );
    }
    let planned = await this.plan(app, req, route, build);
    let provider: LLMProvider;
    try {
      provider = await this.resolve(route);
    } catch (err) {
      await this.quota.release(planned.reservation).catch(() => undefined);
      throw err;
    }

    const controller = new AbortController();
    let finished = false;
    res.on('close', () => {
      if (!finished) controller.abort();
    });
    const send = (e: PlatformStreamEvent) => {
      if (req.stream && !res.destroyed && !res.writableEnded) {
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      }
    };
    let heartbeat: NodeJS.Timeout | null = null;
    if (req.stream) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n');
      }, HEARTBEAT_MS);
    }
    const unmask = createUnmasker(dlp.mapping);
    const sendMeta = (p: Planned) =>
      send({
        type: 'meta',
        id: p.reservation.txnId,
        model: modelInfo(p.route),
        routeReason: p.route.reason,
      });
    sendMeta(planned);

    let result: Attempt;
    let fellBack = false;
    try {
      for (;;) {
        result = await runAttempt(
          planned,
          provider,
          controller.signal,
          (delta) => {
            const text = unmask.push(delta);
            if (text) send({ type: 'delta', text });
          },
          this.logger,
        );
        const providerId = planned.route.model.providerId;
        if (result.error?.retryable) this.circuit.failure(providerId);
        else if (!result.error) this.circuit.success(providerId);

        const canFallBack =
          !fellBack &&
          result.text === '' &&
          !controller.signal.aborted &&
          (result.error?.retryable === true || result.stopReason === 'refusal');
        const next = canFallBack
          ? await this.router.fallback(planned.route, APP_ROLE).catch(() => null)
          : null;
        if (!next || (isPremiumTier(next.model.tier) && !app.client.allowAdvanced)) break;
        await this.settle(planned, result, Date.now() - started);
        try {
          const p = await this.plan(app, req, next, build, planned.route.model.id);
          try {
            provider = await this.resolve(next);
          } catch (err) {
            await this.quota.release(p.reservation).catch(() => undefined);
            throw err;
          }
          planned = p;
          fellBack = true;
          sendMeta(planned);
        } catch (err) {
          this.logger.warn(`Không chuyển được sang model dự phòng: ${String(err)}`);
          // The failed attempt is already settled: report it as is.
          return this.finish(app, req, res, planned, result, null, started, send, heartbeat, () => {
            finished = true;
          });
        }
      }
    } catch (err) {
      if (heartbeat) clearInterval(heartbeat);
      throw err;
    }
    const cost = await this.settle(planned, result, Date.now() - started);
    const rest = unmask.flush();
    if (rest) send({ type: 'delta', text: rest });
    result.text = unmaskText(result.text, dlp.mapping);
    return this.finish(app, req, res, planned, result, cost, started, send, heartbeat, () => {
      finished = true;
    });
  }

  private finish(
    app: AppContext,
    req: PlatformChatRequest,
    res: Response,
    planned: Planned,
    result: Attempt,
    cost: number | null,
    started: number,
    send: (e: PlatformStreamEvent) => void,
    heartbeat: NodeJS.Timeout | null,
    markFinished: () => void,
  ): void {
    if (heartbeat) clearInterval(heartbeat);
    const latencyMs = Date.now() - started;
    const status = result.error
      ? 'error'
      : result.stopReason === 'cancelled'
        ? 'cancelled'
        : 'complete';
    this.audit.recordQuietly({
      event: 'AI_REQUEST',
      actor: this.actor(app),
      target: `usageTransactions/${planned.reservation.txnId}`,
      metadata: {
        model: planned.route.model.id,
        provider: planned.route.model.providerId,
        status,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        cachedInputTokens: result.usage?.cachedInputTokens ?? 0,
        cost,
        latencyMs,
        reference: req.reference ?? null,
      },
    });
    markFinished();
    if (req.stream) {
      if (result.error)
        send({ type: 'error', code: result.error.code, message: result.error.message });
      send({
        type: 'done',
        id: planned.reservation.txnId,
        stopReason: result.stopReason,
        usage: result.usage,
        cost,
        latencyMs,
      });
      if (!res.writableEnded) res.end();
      return;
    }
    if (res.destroyed) return;
    if (result.error && !result.text) {
      // Nothing usable: an error status, with the cost (if any) already in the ledger.
      res.status(result.error.retryable ? 503 : 502).json({
        statusCode: result.error.retryable ? 503 : 502,
        message: result.error.message,
        code: result.error.code,
        id: planned.reservation.txnId,
      });
      return;
    }
    const body: PlatformChatResponse = {
      id: planned.reservation.txnId,
      model: modelInfo(planned.route),
      routeReason: planned.route.reason,
      output: result.text,
      stopReason: result.stopReason,
      usage: result.usage,
      cost,
      latencyMs,
    };
    res.status(200).json(body);
  }
}
