import {
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { AppClientStore, DepartmentStore, QuotaService } from '@uniai/firestore';
import {
  buildPlatformOpenApi,
  createAppClientRequestSchema,
  quotaPeriodOf,
  updateAppClientRequestSchema,
  type AppClient,
  type AppClientKeyResponse,
  type AppClientView,
} from '@uniai/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { Roles } from '../auth/decorators.js';
import { QUOTA_SERVICE } from '../chat/chat.service.js';
import { parseOrBadRequest } from '../common/zod.js';
import { DEPARTMENT_STORE } from '../departments/departments.controller.js';
import { APP_CLIENT_STORE } from './tokens.js';

/** What the audit trail keeps of an app: never the key or its hash. */
const auditView = (c: AppClient) => ({
  name: c.name,
  ownerDepartmentId: c.ownerDepartmentId,
  scopes: c.scopes,
  monthlyBudget: c.monthlyBudget,
  requestsPerMinute: c.requestsPerMinute,
  allowAdvanced: c.allowAdvanced,
  status: c.status,
});

/**
 * Internal applications of the Platform API (M17): Super Admin and AI Admin register them,
 * set budgets and rotate keys; Auditors read. A key is shown only in the create/rotate
 * response.
 */
@Controller('api/admin')
export class AppClientsController {
  constructor(
    @Inject(APP_CLIENT_STORE) private readonly apps: AppClientStore,
    @Inject(DEPARTMENT_STORE) private readonly departments: DepartmentStore,
    @Inject(QUOTA_SERVICE) private readonly quota: QuotaService,
    private readonly audit: AuditService,
  ) {}

  private async view(c: AppClient, period: string): Promise<AppClientView> {
    return { ...c, period, ...(await this.quota.appUsage(c.id, period)) };
  }

  private async own(id: string): Promise<AppClient> {
    const client = await this.apps.get(id);
    if (!client) throw new NotFoundException('Không tìm thấy ứng dụng.');
    return client;
  }

  @Get('app-clients')
  @Roles('super_admin', 'ai_admin', 'auditor')
  async list(): Promise<{ clients: AppClientView[] }> {
    const period = quotaPeriodOf(new Date());
    const clients = await this.apps.list();
    return { clients: await Promise.all(clients.map((c) => this.view(c, period))) };
  }

  @Post('app-clients')
  @Roles('super_admin', 'ai_admin')
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<AppClientKeyResponse> {
    const input = parseOrBadRequest(createAppClientRequestSchema, body);
    const department = await this.departments.get(input.ownerDepartmentId);
    if (!department || department.status !== 'active') {
      throw new NotFoundException(`Không có đơn vị ${input.ownerDepartmentId}.`);
    }
    const result = await this.apps.create(
      input,
      { id: department.id, path: department.path },
      auth.profile.uid,
    );
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: `appClients/${result.client.id}`,
      metadata: { action: 'app_client_create', after: auditView(result.client) },
    });
    return result;
  }

  @Patch('app-clients/:id')
  @Roles('super_admin', 'ai_admin')
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AppClientView> {
    const before = await this.own(id);
    const patch = parseOrBadRequest(updateAppClientRequestSchema, body);
    const after = await this.apps.update(id, patch, auth.profile.uid);
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: `appClients/${id}`,
      metadata: { action: 'app_client_update', before: auditView(before), after: auditView(after) },
    });
    return this.view(after, quotaPeriodOf(new Date()));
  }

  /** New key; the old one stops working at once. */
  @Post('app-clients/:id/rotate')
  @Roles('super_admin', 'ai_admin')
  async rotate(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<AppClientKeyResponse> {
    await this.own(id);
    const result = await this.apps.rotate(id, auth.profile.uid);
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: `appClients/${id}`,
      metadata: { action: 'app_client_rotate_key', keyLast4: result.client.keyLast4 },
    });
    return result;
  }

  /** OpenAPI 3.1 description of the Platform API (spec 10: internal documentation). */
  @Get('platform/openapi.json')
  @Roles('super_admin', 'ai_admin', 'auditor')
  openapi(): Record<string, unknown> {
    return buildPlatformOpenApi();
  }
}
