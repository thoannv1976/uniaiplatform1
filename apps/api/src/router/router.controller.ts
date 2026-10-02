import { Body, Controller, Get, HttpCode, Inject, Post, Put } from '@nestjs/common';
import type { RouterConfigStore } from '@uniai/firestore';
import {
  CHAT_MODEL_AUTO,
  routerConfigSchema,
  routerTestRequestSchema,
  type RouterTestResponse,
  type RouterView,
} from '@uniai/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { Roles } from '../auth/decorators.js';
import { ModelRouter } from '../chat/model-router.js';
import { parseOrBadRequest } from '../common/zod.js';
import { ROUTER_CONFIG_STORE, RouterService } from './router.service.js';

/** Smart Router settings (spec 8.6): AI Admin and Super Admin edit, Auditor reads. */
@Controller('api/admin/router')
export class RouterController {
  constructor(
    @Inject(ROUTER_CONFIG_STORE) private readonly store: RouterConfigStore,
    private readonly service: RouterService,
    private readonly router: ModelRouter,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Roles('super_admin', 'ai_admin', 'auditor')
  async get(): Promise<RouterView> {
    const [{ config, updatedBy, updatedAt }, shares] = await Promise.all([
      this.store.get(),
      this.service.actualShares(),
    ]);
    const { period, requests, ...actual } = shares;
    return { config, period, requests, actual, updatedBy, updatedAt };
  }

  @Put()
  @Roles('super_admin', 'ai_admin')
  async set(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<RouterView> {
    const config = parseOrBadRequest(routerConfigSchema, body);
    const before = (await this.store.get()).config;
    await this.store.set(config, auth.profile.uid);
    this.service.invalidate();
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: 'settings:router',
      metadata: {
        action: 'router_config',
        before: { rules: before.rules.length, targets: before.targets },
        after: {
          rules: config.rules.length,
          enabledRules: config.rules.filter((r) => r.enabled).map((r) => r.id),
          targets: config.targets,
          defaultTier: config.defaultTier,
          enforceTargets: config.enforceTargets,
        },
      },
    });
    return this.get();
  }

  /** Which tier and model AUTO would pick for a sample question (nothing is sent to AI). */
  @Post('test')
  @HttpCode(200)
  @Roles('super_admin', 'ai_admin')
  async test(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<RouterTestResponse> {
    const input = parseOrBadRequest(routerTestRequestSchema, body);
    const decision = await this.service.decide(input);
    const route = await this.router
      .choose(CHAT_MODEL_AUTO, auth.profile.role, {
        decision,
        requireImage: input.imageCount > 0,
      })
      .catch(() => null);
    return {
      ...decision,
      reason: route?.reason ?? decision.reason,
      modelId: route?.model.id ?? null,
      modelName: route?.model.displayName ?? null,
    };
  }
}
