import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SecretStoreError } from '@uniai/ai-providers';
import type { IntegrationStore } from '@uniai/firestore';
import {
  DLP_DETECTORS,
  integrationIdSchema,
  maskText,
  scanText,
  setIntegrationTokenRequestSchema,
  testOperationRequestSchema,
  upsertIntegrationRequestSchema,
  type Integration,
  type TestOperationResponse,
} from '@uniai/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { Roles } from '../auth/decorators.js';
import { parseOrBadRequest } from '../common/zod.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { IntegrationClient, integrationUrlAllowed } from './integration-client.js';
import { INTEGRATION_STORE } from './tokens.js';

const PREVIEW_CHARS = 2000;

/**
 * Integration points (M18): Super Admin / AI Admin register read-only connectors to
 * LMS/ERP/SIS after the system's survey (docs/integrations/TEMPLATE.md); Auditors read.
 * The token is write-only: stored in Secret Manager, Firestore keeps its last 4.
 */
@Controller('api/admin/integrations')
export class IntegrationsController {
  constructor(
    @Inject(INTEGRATION_STORE) private readonly integrations: IntegrationStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly client: IntegrationClient,
    private readonly audit: AuditService,
  ) {}

  private async own(id: string): Promise<Integration> {
    const integration = await this.integrations.get(id);
    if (!integration) throw new NotFoundException('Không tìm thấy tích hợp.');
    return integration;
  }

  @Get()
  @Roles('super_admin', 'ai_admin', 'auditor')
  async list(): Promise<{ integrations: Integration[] }> {
    return { integrations: await this.integrations.list() };
  }

  /** Creates or replaces an integration (its token is kept). */
  @Put(':id')
  @Roles('super_admin', 'ai_admin')
  async put(
    @CurrentAuth() auth: AuthContext,
    @Param('id') rawId: string,
    @Body() body: unknown,
  ): Promise<Integration> {
    const id = parseOrBadRequest(integrationIdSchema, rawId);
    const input = parseOrBadRequest(upsertIntegrationRequestSchema, body);
    if (!integrationUrlAllowed(input.baseUrl, this.config)) {
      throw new BadRequestException('Địa chỉ hệ thống tích hợp phải dùng https://.');
    }
    const saved = await this.integrations.put(id, input, auth.profile.uid);
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: `integrations/${id}`,
      metadata: {
        action: 'integration_put',
        baseUrl: input.baseUrl,
        status: input.status,
        operations: input.operations.map((o) => `${o.method} ${o.path}`),
      },
    });
    return saved;
  }

  @Post(':id/token')
  @HttpCode(204)
  @Roles('super_admin', 'ai_admin')
  async setToken(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.own(id);
    const { token } = parseOrBadRequest(setIntegrationTokenRequestSchema, body);
    try {
      await this.client.setToken(id, token);
    } catch (err) {
      if (err instanceof SecretStoreError && err.status === 404) {
        throw new ServiceUnavailableException(
          `Chưa có secret cho tích hợp ${id}: chạy infra/integration-secret.sh --id ${id} trước.`,
        );
      }
      throw err;
    }
    await this.integrations.setTokenLast4(id, token.slice(-4), auth.profile.uid);
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: `integrations/${id}`,
      metadata: { action: 'integration_token' },
    });
  }

  /** One call with sample arguments; the preview is DLP-masked and cut to 2,000 characters. */
  @Post(':id/operations/:op/test')
  @HttpCode(200)
  @Roles('super_admin', 'ai_admin')
  async test(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Param('op') opId: string,
    @Body() body: unknown,
  ): Promise<TestOperationResponse> {
    const integration = await this.own(id);
    const op = integration.operations.find((o) => o.id === opId);
    if (!op) throw new NotFoundException('Không có thao tác này.');
    const { arguments: args } = parseOrBadRequest(testOperationRequestSchema, body);
    const r = await this.client.call({ ...integration, status: 'active' }, op, args, {
      id: auth.profile.uid,
      label: auth.profile.email ?? auth.profile.uid,
    });
    // Every sensitive value is masked in the preview, whatever the policy.
    const preview = maskText(r.body, scanText(r.body), [...DLP_DETECTORS]).slice(0, PREVIEW_CHARS);
    return {
      ok: r.ok,
      status: r.status,
      bytes: r.bytes,
      durationMs: r.durationMs,
      preview,
      error: r.error,
    };
  }
}
