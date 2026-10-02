import { Body, Controller, Get, Inject, Post, Res } from '@nestjs/common';
import type { QuotaService } from '@uniai/firestore';
import {
  isPremiumTier,
  platformChatRequestSchema,
  quotaPeriodOf,
  type PlatformModelsResponse,
  type PlatformUsageResponse,
} from '@uniai/shared';
import type { Response } from 'express';
import type { AppContext } from '../auth/auth.guard.js';
import { CurrentApp } from '../auth/current-user.js';
import { AppScopeRequired } from '../auth/decorators.js';
import { QUOTA_SERVICE } from '../chat/chat.service.js';
import { ModelRouter } from '../chat/model-router.js';
import { parseOrBadRequest } from '../common/zod.js';
import { PlatformChatService } from './platform-chat.service.js';

/**
 * Platform API v1 (spec 10, M17) for internal applications. Authorization: Bearer uak_…
 * (an application key with the endpoint's scope); staff logins are not accepted here.
 * Contract: docs/platform/openapi.json.
 */
@Controller('api/platform/v1')
export class PlatformController {
  constructor(
    private readonly chatService: PlatformChatService,
    private readonly router: ModelRouter,
    @Inject(QUOTA_SERVICE) private readonly quota: QuotaService,
  ) {}

  /** One answer as JSON, or Server-Sent Events with "stream": true. */
  @Post('chat')
  @AppScopeRequired('chat')
  async chat(
    @CurrentApp() app: AppContext,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const request = parseOrBadRequest(platformChatRequestSchema, body);
    await this.chatService.chat(app, request, res);
  }

  /** Models the application may request by id (besides "auto"). */
  @Get('models')
  @AppScopeRequired('models')
  async models(@CurrentApp() app: AppContext): Promise<PlatformModelsResponse> {
    const options = await this.router.options('user');
    return {
      models: options
        .filter((m) => app.client.allowAdvanced || !isPremiumTier(m.tier))
        .map((m) => ({
          id: m.id,
          displayName: m.displayName,
          providerId: m.providerId,
          tier: m.tier,
          capabilities: m.capabilities,
        })),
    };
  }

  /** This month's budget and spend of the calling application. */
  @Get('usage')
  @AppScopeRequired('usage')
  async usage(@CurrentApp() app: AppContext): Promise<PlatformUsageResponse> {
    const period = quotaPeriodOf(new Date());
    const { used, reserved } = await this.quota.appUsage(app.client.id, period);
    return {
      appId: app.client.id,
      period,
      monthlyBudget: app.client.monthlyBudget,
      used,
      reserved,
      remaining: app.client.monthlyBudget - used - reserved,
      requestsPerMinute: app.client.requestsPerMinute,
    };
  }
}
