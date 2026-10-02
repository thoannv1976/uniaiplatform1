import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { probe } from '@uniai/ai-providers';
import type { RegistryStore } from '@uniai/firestore';
import {
  createModelRequestSchema,
  DEFAULT_TEST_PROMPT,
  modelIdSchema,
  newPriceSchema,
  testModelRequestSchema,
  updateModelRequestSchema,
  usageCost,
  type ModelView,
  type Price,
  type TestModelResponse,
} from '@uniai/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { Roles } from '../auth/decorators.js';
import { parseOrBadRequest } from '../common/zod.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ProviderRuntime, ProviderUnavailableError } from './provider-runtime.js';
import { RegistryCache } from './registry-cache.js';
import { REGISTRY_STORE } from './tokens.js';

/** Admin test calls stay short and cheap. */
const TEST_MAX_OUTPUT_TOKENS = 1024;

function modelIdOr404(raw: string): string {
  const parsed = modelIdSchema.safeParse(raw);
  if (!parsed.success) throw new NotFoundException(`Không có model ${raw}.`);
  return parsed.data;
}

@Controller('api/admin/models')
export class ModelsController {
  constructor(
    @Inject(REGISTRY_STORE) private readonly registry: RegistryStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly runtime: ProviderRuntime,
    private readonly cache: RegistryCache,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Roles('super_admin', 'ai_admin', 'auditor')
  async list(): Promise<{ models: ModelView[] }> {
    return { models: await this.registry.listModels() };
  }

  @Post()
  @Roles('super_admin', 'ai_admin')
  async create(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<ModelView> {
    const input = parseOrBadRequest(createModelRequestSchema, body);
    const created = await this.registry.createModel(input, auth.profile.uid);
    this.cache.invalidate();
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: `model:${created.id}`,
      metadata: { action: 'create_model', model: input },
    });
    return created;
  }

  /** Adds the built-in catalogue models that are missing (never changes existing ones). */
  @Post('seed')
  @HttpCode(200)
  @Roles('super_admin', 'ai_admin')
  async seed(@CurrentAuth() auth: AuthContext): Promise<{ created: string[] }> {
    const created = await this.registry.seedDefaults(auth.profile.uid, {
      includeMock: this.config.mockProviderEnabled,
    });
    this.cache.invalidate();
    if (created.length > 0) {
      await this.audit.record({
        event: 'ADMIN_CHANGE',
        actor: auth.profile.uid,
        target: 'models',
        metadata: { action: 'seed_models', created },
      });
    }
    return { created };
  }

  @Patch(':id')
  @Roles('super_admin', 'ai_admin')
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('id') rawId: string,
    @Body() body: unknown,
  ): Promise<ModelView> {
    const id = modelIdOr404(rawId);
    const patch = parseOrBadRequest(updateModelRequestSchema, body);
    const { before, after } = await this.registry.updateModel(id, patch, auth.profile.uid);
    this.cache.invalidate();
    const changed = Object.keys(patch) as (keyof typeof patch)[];
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: `model:${id}`,
      metadata: {
        action: 'update_model',
        changes: patch,
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
      },
    });
    return after;
  }

  @Get(':id/prices')
  @Roles('super_admin', 'ai_admin', 'auditor')
  async prices(@Param('id') rawId: string): Promise<{ prices: Price[] }> {
    const id = modelIdOr404(rawId);
    if (!(await this.registry.getModel(id))) throw new NotFoundException(`Không có model ${id}.`);
    return { prices: await this.registry.listPrices(id) };
  }

  @Post(':id/prices')
  @Roles('super_admin', 'ai_admin')
  async addPrice(
    @CurrentAuth() auth: AuthContext,
    @Param('id') rawId: string,
    @Body() body: unknown,
  ): Promise<Price> {
    const id = modelIdOr404(rawId);
    const input = parseOrBadRequest(newPriceSchema, body);
    const price = await this.registry.addPrice(id, input, auth.profile.uid);
    this.cache.invalidate();
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: `model:${id}`,
      metadata: {
        action: 'add_price',
        price: {
          inputPerMTok: price.inputPerMTok,
          outputPerMTok: price.outputPerMTok,
          cachedInputPerMTok: price.cachedInputPerMTok,
          effectiveFrom: price.effectiveFrom,
        },
      },
    });
    return price;
  }

  /**
   * One short real call, also for disabled models, so an admin can check the model id,
   * access and price before turning a model on. It costs real money and is audited; it
   * is not charged to anyone's quota.
   */
  @Post(':id/test')
  @HttpCode(200)
  @Roles('super_admin', 'ai_admin')
  async test(
    @CurrentAuth() auth: AuthContext,
    @Param('id') rawId: string,
    @Body() body: unknown,
  ): Promise<TestModelResponse> {
    const id = modelIdOr404(rawId);
    const { prompt } = parseOrBadRequest(testModelRequestSchema, body ?? {});
    const model = await this.registry.getModel(id);
    if (!model) throw new NotFoundException(`Không có model ${id}.`);
    const settings = await this.registry.getProvider(model.providerId);

    let provider;
    try {
      provider = await this.runtime.resolve(settings);
    } catch (err) {
      if (err instanceof ProviderUnavailableError) throw new BadRequestException(err.message);
      throw err;
    }
    const result = await probe(provider, {
      model: model.apiModelId,
      messages: [{ role: 'user', content: prompt ?? DEFAULT_TEST_PROMPT }],
      maxOutputTokens: Math.min(model.maxOutputTokens, TEST_MAX_OUTPUT_TOKENS),
      reasoningEffort: model.defaultParams.reasoningEffort,
    });
    const cost =
      result.usage && model.currentPrice ? usageCost(result.usage, model.currentPrice) : null;
    const response: TestModelResponse = {
      ok: result.error === null && result.stopReason !== null,
      modelId: model.id,
      apiModelId: model.apiModelId,
      transport: provider.transport,
      text: result.text,
      stopReason: result.stopReason,
      usage: result.usage,
      cost,
      latencyMs: result.latencyMs,
      error: result.error,
    };
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: `model:${id}`,
      metadata: {
        action: 'test_model',
        ok: response.ok,
        transport: response.transport,
        usage: response.usage,
        cost,
        error: response.error?.code ?? null,
      },
    });
    return response;
  }
}
