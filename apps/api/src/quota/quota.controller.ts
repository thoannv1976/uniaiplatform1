import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { DepartmentStore, QuotaActor, QuotaService } from '@uniai/firestore';
import {
  departmentCodeSchema,
  QUOTA_TIER_IDS,
  quotaAdjustmentRequestSchema,
  quotaPeriodOf,
  quotaPeriodSchema,
  setBudgetRequestSchema,
  updateQuotaTierRequestSchema,
  type Budget,
  type QuotaAdjustment,
  type QuotaSummary,
  type QuotaTier,
  type QuotaTierId,
} from '@uniai/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { AnyRole, Roles } from '../auth/decorators.js';
import { QUOTA_SERVICE } from '../chat/chat.service.js';
import { parseOrBadRequest } from '../common/zod.js';
import { DEPARTMENT_STORE } from '../departments/departments.controller.js';

const actorOf = (auth: AuthContext): QuotaActor => ({
  uid: auth.profile.uid,
  role: auth.profile.role,
  scopeDepartmentId: auth.profile.scopeDepartmentId,
});

function periodOr400(raw: string | undefined): string {
  return raw ? parseOrBadRequest(quotaPeriodSchema, raw) : quotaPeriodOf(new Date());
}

/** The signed-in user's own quota (chat header, "My usage"). */
@Controller('api/me')
export class MyQuotaController {
  constructor(@Inject(QUOTA_SERVICE) private readonly quota: QuotaService) {}

  @Get('quota')
  @AnyRole()
  async mine(@CurrentAuth() auth: AuthContext): Promise<QuotaSummary> {
    const summary = await this.quota.summary(auth.profile.uid);
    if (!summary) throw new NotFoundException('Không tìm thấy hồ sơ người dùng.');
    return summary;
  }
}

/**
 * Quotas and unit budgets (spec 8.7). Super Admin: everything; Unit Admin: people and
 * sub-units of their unit; Auditor: read-only. Every change carries a reason (audit).
 */
@Controller('api/admin')
export class AdminQuotaController {
  constructor(
    @Inject(QUOTA_SERVICE) private readonly quota: QuotaService,
    @Inject(DEPARTMENT_STORE) private readonly departments: DepartmentStore,
    private readonly audit: AuditService,
  ) {}

  private scopeOf(auth: AuthContext, requested?: string): string | undefined {
    if (auth.profile.role !== 'unit_admin') return requested || undefined;
    const scope = auth.profile.scopeDepartmentId;
    if (!scope) throw new ForbiddenException('Tài khoản quản trị đơn vị chưa được gán đơn vị.');
    return scope;
  }

  @Get('quotas')
  @Roles('super_admin', 'unit_admin', 'auditor')
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query('period') rawPeriod?: string,
    @Query('departmentId') departmentId?: string,
  ): Promise<{ period: string; quotas: QuotaSummary[] }> {
    const period = periodOr400(rawPeriod);
    const scope = this.scopeOf(auth, departmentId);
    return { period, quotas: await this.quota.list(period, scope) };
  }

  @Post('quota-adjustments')
  @Roles('super_admin', 'unit_admin')
  async adjust(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<QuotaAdjustment> {
    const input = parseOrBadRequest(quotaAdjustmentRequestSchema, body);
    const adjustment = await this.quota.adjust(input, actorOf(auth));
    await this.audit.record({
      event: 'QUOTA_CHANGE',
      actor: auth.profile.uid,
      target: `user:${input.uid}`,
      metadata: {
        action: 'adjust_quota',
        period: adjustment.period,
        type: input.type,
        kind: input.kind,
        amount: input.amount,
        delta: adjustment.delta,
        reason: input.reason,
        approvedBy: input.approvedBy,
        expiresAt: input.expiresAt ?? null,
      },
    });
    return adjustment;
  }

  @Get('quota-adjustments')
  @Roles('super_admin', 'unit_admin', 'auditor')
  async adjustments(
    @CurrentAuth() auth: AuthContext,
    @Query('uid') uid?: string,
    @Query('period') rawPeriod?: string,
  ): Promise<{ adjustments: QuotaAdjustment[] }> {
    const period = rawPeriod ? periodOr400(rawPeriod) : undefined;
    const all = await this.quota.listAdjustments({ uid, period });
    const scope = this.scopeOf(auth);
    if (!scope) return { adjustments: all };
    const inScope = new Set(
      (await this.quota.list(period ?? quotaPeriodOf(new Date()), scope)).map((q) => q.uid),
    );
    return { adjustments: all.filter((a) => inScope.has(a.uid)) };
  }

  @Get('quota-tiers')
  @Roles('super_admin', 'unit_admin', 'auditor', 'ai_admin')
  async tiers(): Promise<{ tiers: QuotaTier[] }> {
    return { tiers: Object.values(await this.quota.tiers()) };
  }

  @Patch('quota-tiers/:id')
  @Roles('super_admin')
  async updateTier(
    @CurrentAuth() auth: AuthContext,
    @Param('id') rawId: string,
    @Body() body: unknown,
  ): Promise<QuotaTier> {
    if (!(QUOTA_TIER_IDS as readonly string[]).includes(rawId)) {
      throw new NotFoundException(`Không có nhóm định mức ${rawId}.`);
    }
    const patch = parseOrBadRequest(updateQuotaTierRequestSchema, body);
    const before = (await this.quota.tiers())[rawId as QuotaTierId];
    const after = await this.quota.updateTier(rawId as QuotaTierId, patch, auth.profile.uid);
    await this.audit.record({
      event: 'QUOTA_CHANGE',
      actor: auth.profile.uid,
      target: `quotaTier:${rawId}`,
      metadata: { action: 'update_quota_tier', changes: patch, before },
    });
    return after;
  }

  @Get('budgets')
  @Roles('super_admin', 'unit_admin', 'auditor')
  async budgets(
    @CurrentAuth() auth: AuthContext,
    @Query('period') rawPeriod?: string,
  ): Promise<{ period: string; budgets: Budget[] }> {
    const period = periodOr400(rawPeriod);
    const budgets = await this.quota.listBudgets(period);
    const scope = this.scopeOf(auth);
    if (!scope) return { period, budgets };
    const departments = await this.departments.map();
    return {
      period,
      budgets: budgets.filter((b) => departments.get(b.departmentId)?.path.includes(scope)),
    };
  }

  @Put('budgets/:departmentId')
  @Roles('super_admin', 'unit_admin')
  async setBudget(
    @CurrentAuth() auth: AuthContext,
    @Param('departmentId') rawId: string,
    @Body() body: unknown,
  ): Promise<{ period: string; budgets: Budget[] }> {
    const id = departmentCodeSchema.safeParse(rawId);
    const department = id.success ? await this.departments.get(id.data) : null;
    if (!department) throw new NotFoundException(`Không có đơn vị ${rawId}.`);
    const input = parseOrBadRequest(setBudgetRequestSchema, body);
    const period = input.period ?? quotaPeriodOf(new Date());
    await this.quota.setBudget(department, period, input.budget, actorOf(auth));
    await this.audit.record({
      event: 'BUDGET_CHANGE',
      actor: auth.profile.uid,
      target: `department:${department.id}`,
      metadata: { action: 'set_budget', period, budget: input.budget, reason: input.reason },
    });
    return this.budgets(auth, period);
  }
}
