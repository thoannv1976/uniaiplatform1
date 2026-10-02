import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import type { AgentStore, IntegrationStore, UserStore } from '@uniai/firestore';
import {
  agentRunRequestSchema,
  upsertAgentRequestSchema,
  type Agent,
  type AgentSummary,
  type UpsertAgentRequest,
  type UserProfile,
} from '@uniai/shared';
import type { Response } from 'express';
import { AuditService } from '../audit/audit.service.js';
import { USER_STORE, type AppContext, type AuthContext } from '../auth/auth.guard.js';
import { CurrentApp, CurrentAuth } from '../auth/current-user.js';
import { AnyRole, AppScopeRequired, Roles } from '../auth/decorators.js';
import { requireTerms } from '../common/terms.js';
import { parseOrBadRequest } from '../common/zod.js';
import { AgentRunner } from './agent-runner.service.js';
import { AGENT_STORE, INTEGRATION_STORE } from './tokens.js';

/** Administrators see and run every agent (to check what they configured). */
const ALL_AGENTS_ROLES = ['super_admin', 'ai_admin'];
const summary = (a: Agent): AgentSummary => ({
  id: a.id,
  name: a.name,
  description: a.description,
  tools: a.tools,
});

/** AI Agents (M18): Super Admin / AI Admin configure, staff and apps run. */
@Controller('api')
export class AgentsController {
  constructor(
    @Inject(AGENT_STORE) private readonly agents: AgentStore,
    @Inject(INTEGRATION_STORE) private readonly integrations: IntegrationStore,
    @Inject(USER_STORE) private readonly users: UserStore,
    private readonly runner: AgentRunner,
    private readonly audit: AuditService,
  ) {}

  /** Every integration tool must name an existing operation. */
  private async validate(input: UpsertAgentRequest) {
    for (const tool of input.tools) {
      if (!tool.includes('.')) continue;
      const [integrationId, opId] = tool.split('.') as [string, string];
      const integration = await this.integrations.get(integrationId);
      if (!integration?.operations.some((o) => o.id === opId)) {
        throw new BadRequestException(`Không có thao tác tích hợp "${tool}".`);
      }
    }
  }

  private async visibleTo(profile: UserProfile): Promise<Agent[]> {
    const all = (await this.agents.list()).filter((a) => a.status === 'active');
    if (ALL_AGENTS_ROLES.includes(profile.role)) return all;
    const path = await this.users.departmentPathOf(profile.uid);
    return all.filter(
      (a) => a.publishedTo.length === 0 || a.publishedTo.some((d) => path.includes(d)),
    );
  }

  // --- administration ---------------------------------------------------------------

  @Get('admin/agents')
  @Roles('super_admin', 'ai_admin', 'auditor')
  async list(): Promise<{ agents: Agent[] }> {
    return { agents: await this.agents.list() };
  }

  @Post('admin/agents')
  @Roles('super_admin', 'ai_admin')
  async create(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<Agent> {
    const input = parseOrBadRequest(upsertAgentRequestSchema, body);
    await this.validate(input);
    const agent = await this.agents.create(input, auth.profile.uid);
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: `agents/${agent.id}`,
      metadata: {
        action: 'agent_create',
        name: agent.name,
        tools: agent.tools,
        model: agent.model,
      },
    });
    return agent;
  }

  @Put('admin/agents/:id')
  @Roles('super_admin', 'ai_admin')
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Agent> {
    const input = parseOrBadRequest(upsertAgentRequestSchema, body);
    await this.validate(input);
    const agent = await this.agents.update(id, input, auth.profile.uid);
    if (!agent) throw new NotFoundException('Không tìm thấy agent.');
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: `agents/${id}`,
      metadata: {
        action: 'agent_update',
        tools: agent.tools,
        model: agent.model,
        status: agent.status,
        allowApps: agent.allowApps,
      },
    });
    return agent;
  }

  // --- staff --------------------------------------------------------------------------

  @Get('agents')
  @AnyRole()
  async mine(@CurrentAuth() auth: AuthContext): Promise<{ agents: AgentSummary[] }> {
    return { agents: (await this.visibleTo(auth.profile)).map(summary) };
  }

  /** Server-Sent Events (agentStreamEventSchema); nothing is stored but the ledger. */
  @Post('agents/:id/run')
  @AnyRole()
  async run(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    requireTerms(auth.profile);
    const agent = (await this.visibleTo(auth.profile)).find((a) => a.id === id);
    if (!agent)
      throw new NotFoundException('Không tìm thấy agent hoặc bạn không được dùng agent này.');
    const request = parseOrBadRequest(agentRunRequestSchema, body);
    await this.runner.run({ kind: 'user', profile: auth.profile }, agent, request, res);
  }

  // --- Platform API (scope "agents") --------------------------------------------------

  @Get('platform/v1/agents')
  @AppScopeRequired('agents')
  async forApps(): Promise<{ agents: AgentSummary[] }> {
    const agents = (await this.agents.list()).filter((a) => a.status === 'active' && a.allowApps);
    return { agents: agents.map(summary) };
  }

  @Post('platform/v1/agents/:id/run')
  @AppScopeRequired('agents')
  async runForApp(
    @CurrentApp() app: AppContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const agent = await this.agents.get(id);
    if (!agent || agent.status !== 'active' || !agent.allowApps) {
      throw new NotFoundException('Không tìm thấy agent hoặc agent không mở cho ứng dụng.');
    }
    const request = parseOrBadRequest(agentRunRequestSchema, body);
    await this.runner.run({ kind: 'app', app }, agent, request, res);
  }
}
