import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import type { ChatMessage as ProviderMessage, LLMProvider } from '@uniai/ai-providers';
import type { IntegrationStore, QuotaService, Reservation } from '@uniai/firestore';
import {
  BUILTIN_TOOL_LABELS_VI,
  buildToolPrompt,
  CHAT_MODEL_AUTO,
  createUnmasker,
  decide,
  DLP_DETECTOR_LABELS_VI,
  isPremiumTier,
  parseToolCall,
  scanText,
  tokenCost,
  toolResultMessage,
  unmaskText,
  usageCost,
  type Agent,
  type AgentRunRequest,
  type AgentStreamEvent,
  type DlpDetector,
  type Integration,
  type IntegrationOperation,
  type Role,
  type ToolDescription,
  type UserProfile,
} from '@uniai/shared';
import type { Response } from 'express';
import { ProviderRuntime } from '../ai/provider-runtime.js';
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
import { DlpService, type DlpOutcome } from '../dlp/dlp.service.js';
import { KnowledgeRetrieval } from '../knowledge/retrieval.service.js';
import { CircuitBreaker } from '../resilience/circuit-breaker.js';
import { RouterService } from '../router/router.service.js';
import { IntegrationClient } from './integration-client.js';
import { INTEGRATION_STORE } from './tokens.js';

const MAX_OUTPUT_TOKENS = 8_000;
const HISTORY_CHARS_PER_TOKEN = 2;
const HISTORY_MAX_CHARS = 300_000;
/** Text of one tool result given to the model. */
const TOOL_RESULT_MAX_CHARS = 12_000;
const HEARTBEAT_MS = 15_000;

/** Who runs the agent: a staff member (web) or an application (Platform API). */
export type AgentCaller = { kind: 'user'; profile: UserProfile } | { kind: 'app'; app: AppContext };

interface Tool {
  description: ToolDescription;
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<{ ok: boolean; text: string }>;
}

type Turn = { role: 'user' | 'assistant'; content: string };

const modelInfo = (r: Route) => ({
  id: r.model.id,
  displayName: r.model.displayName,
  providerId: r.model.providerId,
  tier: r.model.tier,
});

/**
 * Runs an agent (M18, ADR 0017): a loop of model steps where the model may call one tool
 * per step with the JSON protocol of packages/shared/src/agents.ts, until it answers or the
 * agent's step limit is reached. Every step is reserved and settled through QuotaService
 * (ledger agentId); tool results pass the DLP policy before the model sees them.
 */
@Injectable()
export class AgentRunner {
  private readonly logger = new Logger('Agents');

  constructor(
    private readonly router: ModelRouter,
    private readonly runtime: ProviderRuntime,
    @Inject(QUOTA_SERVICE) private readonly quota: QuotaService,
    @Inject(INTEGRATION_STORE) private readonly integrations: IntegrationStore,
    private readonly client: IntegrationClient,
    private readonly retrieval: KnowledgeRetrieval,
    private readonly circuit: CircuitBreaker,
    private readonly audit: AuditService,
    private readonly smartRouter: RouterService,
    private readonly dlp: DlpService,
  ) {}

  private actorId(caller: AgentCaller) {
    return caller.kind === 'user' ? caller.profile.uid : `app:${caller.app.client.id}`;
  }

  private role(caller: AgentCaller): Role {
    return caller.kind === 'user' ? caller.profile.role : 'user';
  }

  /** The agent's tools that this caller may use now (unusable ones are left out). */
  private async tools(agent: Agent, caller: AgentCaller, dlp: DlpOutcome) {
    const tools = new Map<string, Tool>();
    const integrations = new Map<string, Integration | null>();
    for (const name of agent.tools) {
      if (name === 'current_datetime') {
        tools.set(name, {
          description: {
            name,
            description: `${BUILTIN_TOOL_LABELS_VI.current_datetime} (giờ Việt Nam).`,
            parameters: [],
          },
          run: () =>
            Promise.resolve({
              ok: true,
              text: new Date().toLocaleString('vi-VN', {
                timeZone: 'Asia/Ho_Chi_Minh',
                dateStyle: 'full',
                timeStyle: 'short',
              }),
            }),
        });
      } else if (name === 'knowledge_search') {
        if (caller.kind !== 'user' || agent.knowledgeBaseIds.length === 0) continue;
        const visible = new Set((await this.retrieval.visible(caller.profile)).map((k) => k.id));
        const kbIds = agent.knowledgeBaseIds.filter((id) => visible.has(id));
        if (kbIds.length === 0) continue;
        const profile = caller.profile;
        tools.set(name, {
          description: {
            name,
            description:
              'Tìm các đoạn văn bản liên quan trong kho tri thức của Trường (quy chế, quy định, hướng dẫn). Trả về các đoạn có đánh số nguồn [n].',
            parameters: [
              { name: 'query', type: 'string', description: 'Nội dung cần tìm', required: true },
            ],
          },
          run: async (args) => {
            const query = typeof args.query === 'string' ? args.query.slice(0, 1000) : '';
            if (!query) return { ok: false, text: 'Thiếu tham số "query".' };
            const r = await this.retrieval.retrieve(profile, kbIds, query, TOOL_RESULT_MAX_CHARS);
            return { ok: true, text: r.context.replace(/\n*---\nCâu hỏi:\s*$/, '') };
          },
        });
      } else {
        const [integrationId, opId] = name.split('.') as [string, string];
        if (!integrations.has(integrationId)) {
          integrations.set(integrationId, await this.integrations.get(integrationId));
        }
        const integration = integrations.get(integrationId);
        const op = integration?.operations.find((o) => o.id === opId);
        if (!integration || integration.status !== 'active' || !op) continue;
        tools.set(name, this.integrationTool(name, integration, op, caller, dlp));
      }
    }
    return tools;
  }

  private integrationTool(
    name: string,
    integration: Integration,
    op: IntegrationOperation,
    caller: AgentCaller,
    dlp: DlpOutcome,
  ): Tool {
    const actor =
      caller.kind === 'user'
        ? { id: caller.profile.uid, label: caller.profile.email ?? caller.profile.uid }
        : { id: `app:${caller.app.client.id}`, label: `app:${caller.app.client.id}` };
    return {
      description: {
        name,
        description: `[${integration.name}] ${op.description}`,
        parameters: op.parameters.map((p) => ({
          name: p.name,
          type: p.type,
          description: p.description,
          required: p.required,
        })),
      },
      run: async (args, signal) => {
        // The university's own system gets the real values the user typed: masking only
        // keeps them from the AI provider (the result is screened again below).
        const real = Object.fromEntries(
          Object.entries(args).map(([k, v]) => [
            k,
            typeof v === 'string' ? unmaskText(v, dlp.mapping) : v,
          ]),
        );
        const r = await this.client.call(integration, op, real, actor, signal);
        if (!r.ok) return { ok: false, text: r.error ?? 'Lỗi gọi hệ thống tích hợp.' };
        return this.screen(r.body, caller, dlp);
      },
    };
  }

  /**
   * DLP on data coming back from a system: detectors the policy blocks withhold the whole
   * result; masked ones become placeholders (restored in the answer to the caller).
   */
  private async screen(text: string, caller: AgentCaller, dlp: DlpOutcome) {
    const findings = scanText(text);
    if (findings.length === 0) return { ok: true, text };
    const { policy } = await this.dlp.state();
    const subject =
      caller.kind === 'user'
        ? await this.dlp.subject(caller.profile, policy)
        : { role: 'user' as const, departmentPath: caller.app.departmentPath };
    const decision = decide(findings, policy, subject);
    const blocked = decision.byAction.block ?? [];
    if (blocked.length) {
      this.dlp.record(this.actorId(caller), 'block', decision, 'blocked');
      return {
        ok: false,
        text: `Kết quả bị chặn theo chính sách bảo vệ dữ liệu (${blocked
          .map((d: DlpDetector) => DLP_DETECTOR_LABELS_VI[d].toLowerCase())
          .join(', ')}).`,
      };
    }
    return { ok: true, text: dlp.apply(text) };
  }

  private async plan(
    caller: AgentCaller,
    agent: Agent,
    route: Route,
    messages: ProviderMessage[],
    step: number,
    reference: string | null,
  ): Promise<{ reservation: Reservation; maxOutputTokens: number }> {
    let room: number | null;
    if (caller.kind === 'app') {
      const u = await this.quota.appUsage(caller.app.client.id);
      room = caller.app.client.monthlyBudget - u.used - u.reserved;
    } else {
      const s = await this.quota.summary(caller.profile.uid);
      room = s
        ? isPremiumTier(route.model.tier)
          ? Math.min(s.remaining, s.premiumRemaining)
          : s.remaining
        : null;
    }
    const cost = planCost(
      estimateInputTokens(messages),
      Math.min(route.model.maxOutputTokens, MAX_OUTPUT_TOKENS),
      route.model.currentPrice!,
      room,
    );
    const reservation = await this.quota.reserve({
      uid: this.actorId(caller),
      appClientId: caller.kind === 'app' ? caller.app.client.id : null,
      reference,
      agentId: agent.id,
      estimate: cost.estimate,
      premium: caller.kind === 'user' && isPremiumTier(route.model.tier),
      providerId: route.model.providerId,
      transport: route.provider.transport,
      modelId: route.model.id,
      modelTier: route.model.tier,
      apiModelId: route.model.apiModelId,
      priceId: route.model.currentPrice!.id,
      conversationId: null,
      routeReason: `Agent "${agent.name}" – bước ${step}: ${route.reason}`,
    });
    return { reservation, maxOutputTokens: cost.maxOutputTokens };
  }

  private async settle(route: Route, reservation: Reservation, result: Attempt, latencyMs: number) {
    const price = route.model.currentPrice!;
    const { usage } = result;
    const cost = usage ? usageCost(usage, price) : 0;
    try {
      if (usage) {
        await this.quota.commit(reservation, {
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
        await this.quota.release(reservation);
      }
    } catch (err) {
      this.logger.error(
        JSON.stringify({
          event: 'settle_failed',
          txnId: reservation.txnId,
          cost,
          detail: String(err),
        }),
      );
    }
    return cost;
  }

  /** DLP, routing and the first reservation fail as HTTP errors; later problems as events. */
  async run(caller: AgentCaller, agent: Agent, req: AgentRunRequest, res: Response): Promise<void> {
    const started = Date.now();
    const texts = req.messages.map((m) => m.content);
    const dlp =
      caller.kind === 'user'
        ? await this.dlp.check(caller.profile, texts, req.dlpAcknowledged === true)
        : await this.dlp.checkFor(
            this.actorId(caller),
            { role: 'user', departmentPath: caller.app.departmentPath },
            texts,
            req.dlpAcknowledged === true,
          );
    const conv: Turn[] = req.messages.map((m) => ({ role: m.role, content: dlp.apply(m.content) }));
    const tools = await this.tools(agent, caller, dlp);
    const system = [
      agent.instructions,
      buildToolPrompt([...tools.values()].map((t) => t.description)),
    ]
      .filter(Boolean)
      .join('\n\n');

    const question = conv.at(-1)!.content;
    const decision =
      agent.model === CHAT_MODEL_AUTO
        ? await this.smartRouter.decide({
            text: question,
            documentCount: 0,
            imageCount: 0,
            attachedChars: 0,
          })
        : undefined;
    const restrict = caller.kind === 'app' && !caller.app.client.allowAdvanced;
    const route = await this.router.choose(agent.model, this.role(caller), {
      decision,
      excludePremium: restrict,
    });
    if (restrict && isPremiumTier(route.model.tier)) {
      throw new ForbiddenException(
        `Ứng dụng chưa được phép dùng model nhóm Nâng cao/Cao cấp (${route.model.displayName}).`,
      );
    }
    const budget = Math.min(route.model.contextWindow * HISTORY_CHARS_PER_TOKEN, HISTORY_MAX_CHARS);
    const build = () => buildMessages(conv.slice(0, -1), conv.at(-1)!.content, budget, system);
    let messages = build();
    // First reservation before any byte: out of quota → 402, too fast → 429.
    let planned = await this.plan(caller, agent, route, messages, 1, req.reference ?? null);
    let provider: LLMProvider;
    try {
      provider = await this.runtime.resolve(route.provider);
    } catch (err) {
      await this.quota.release(planned.reservation).catch(() => undefined);
      throw err;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const controller = new AbortController();
    let finished = false;
    res.on('close', () => {
      if (!finished) controller.abort();
    });
    const send = (e: AgentStreamEvent) => {
      if (!res.destroyed && !res.writableEnded)
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n');
    }, HEARTBEAT_MS);

    send({
      type: 'meta',
      agent: { id: agent.id, name: agent.name },
      model: modelInfo(route),
      routeReason: route.reason,
    });
    const { decision: dlpDecision } = dlp;
    const masked = (dlpDecision.byAction.mask ?? []).map((d) => ({
      detector: d,
      count: dlpDecision.counts[d] ?? 0,
    }));
    const acknowledged = dlpDecision.byAction.warn ?? [];
    if (masked.length || acknowledged.length) {
      send({ type: 'dlp', masked, acknowledged });
      this.dlp.record(
        this.actorId(caller),
        acknowledged.length ? 'warn' : 'mask',
        dlpDecision,
        'sent',
      );
    }

    let cost = 0;
    let steps = 0;
    const used: string[] = [];
    let stopReason: 'answer' | 'max_steps' | 'error' | 'cancelled';
    try {
      for (;;) {
        steps += 1;
        // Stream as soon as the step is clearly an answer (does not start like JSON).
        const unmask = createUnmasker(dlp.mapping);
        let buffered = '';
        let streaming = false;
        const stepStart = Date.now();
        const result = await runAttempt(
          { route, messages, maxOutputTokens: planned.maxOutputTokens },
          provider,
          controller.signal,
          (delta) => {
            if (streaming) {
              const text = unmask.push(delta);
              if (text) send({ type: 'delta', text });
              return;
            }
            buffered += delta;
            const head = buffered.trimStart();
            if (head && !head.startsWith('{') && !head.startsWith('`')) {
              streaming = true;
              const text = unmask.push(buffered);
              if (text) send({ type: 'delta', text });
            }
          },
          this.logger,
        );
        if (result.error?.retryable) this.circuit.failure(route.model.providerId);
        else if (!result.error) this.circuit.success(route.model.providerId);
        cost += await this.settle(route, planned.reservation, result, Date.now() - stepStart);

        if (controller.signal.aborted || result.stopReason === 'cancelled') {
          stopReason = 'cancelled';
          break;
        }
        if (result.error) {
          send({ type: 'error', code: result.error.code, message: result.error.message });
          stopReason = 'error';
          break;
        }
        const call = streaming ? null : parseToolCall(result.text);
        if (!call) {
          if (!streaming) {
            const text = unmask.push(buffered);
            if (text) send({ type: 'delta', text });
          }
          const rest = unmask.flush();
          if (rest) send({ type: 'delta', text: rest });
          stopReason = 'answer';
          break;
        }
        if (steps >= agent.maxSteps) {
          send({
            type: 'delta',
            text: `Agent đã dùng hết ${agent.maxSteps} bước cho phép mà chưa có câu trả lời. Hãy hỏi cụ thể hơn.`,
          });
          stopReason = 'max_steps';
          break;
        }

        // Run the tool and give the result back to the model.
        const tool = tools.get(call.tool);
        let outcome: { ok: boolean; text: string };
        let status: 'ok' | 'error' | 'denied';
        if (!tool) {
          outcome = {
            ok: false,
            text: `Không có công cụ "${call.tool}". Hãy dùng công cụ trong danh sách.`,
          };
          status = 'denied';
        } else {
          used.push(call.tool);
          try {
            outcome = await tool.run(call.arguments, controller.signal);
          } catch (err) {
            const message = err instanceof ForbiddenException ? err.message : 'Công cụ gặp lỗi.';
            this.logger.warn(`Công cụ ${call.tool} lỗi: ${String(err)}`);
            outcome = { ok: false, text: message };
          }
          status = outcome.ok
            ? 'ok'
            : outcome.text.startsWith('Kết quả bị chặn')
              ? 'denied'
              : 'error';
        }
        const shown = Object.fromEntries(
          Object.entries(call.arguments).map(([k, v]) => [
            k,
            typeof v === 'string' ? unmaskText(v, dlp.mapping) : v,
          ]),
        );
        send({
          type: 'tool',
          step: steps,
          tool: call.tool,
          arguments: shown,
          status,
          message: outcome.ok
            ? `Đã nhận ${outcome.text.length.toLocaleString('vi-VN')} ký tự`
            : outcome.text,
        });
        const resultText =
          outcome.text.length > TOOL_RESULT_MAX_CHARS
            ? `${outcome.text.slice(0, TOOL_RESULT_MAX_CHARS)}\n[… đã cắt bớt]`
            : outcome.text;
        conv.push({ role: 'assistant', content: JSON.stringify(call) });
        conv.push({ role: 'user', content: toolResultMessage(call.tool, outcome.ok, resultText) });
        messages = build();
        try {
          planned = await this.plan(
            caller,
            agent,
            route,
            messages,
            steps + 1,
            req.reference ?? null,
          );
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'Không giữ được định mức cho bước tiếp theo.';
          send({ type: 'error', code: 'quota', message });
          stopReason = 'error';
          break;
        }
      }
    } finally {
      clearInterval(heartbeat);
    }

    const latencyMs = Date.now() - started;
    this.audit.recordQuietly({
      event: 'AGENT_RUN',
      actor: this.actorId(caller),
      target: `agents/${agent.id}`,
      metadata: { steps, tools: used, cost, stopReason, model: route.model.id, latencyMs },
    });
    finished = true;
    send({ type: 'done', steps, cost, stopReason, latencyMs });
    if (!res.writableEnded) res.end();
  }
}
