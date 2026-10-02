import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { QuotaService, SettingsStore } from '@uniai/firestore';
import {
  exchangeRateSchema,
  markNotificationsReadRequestSchema,
  QUOTA_TIER_LABELS_VI,
  quotaPeriodOf,
  quotaPeriodSchema,
  toCsv,
  USAGE_EXPORT_KINDS,
  type AppNotification,
  type Dashboard,
  type ExchangeRate,
  type MyUsage,
} from '@uniai/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { AnyRole, Roles } from '../auth/decorators.js';
import { QUOTA_SERVICE } from '../chat/chat.service.js';
import { parseOrBadRequest } from '../common/zod.js';
import { DashboardService } from './dashboard.service.js';
import { SETTINGS } from './tokens.js';

const periodOf = (raw?: string) =>
  raw ? parseOrBadRequest(quotaPeriodSchema, raw) : quotaPeriodOf(new Date());
const usd = (micro: number) => (micro / 1_000_000).toFixed(6);

@Controller('api/me')
export class MyUsageController {
  constructor(private readonly dashboards: DashboardService) {}

  @Get('usage')
  @AnyRole()
  async usage(
    @CurrentAuth() auth: AuthContext,
    @Query('period') period?: string,
  ): Promise<MyUsage> {
    const usage = await this.dashboards.myUsage(auth.profile.uid, periodOf(period));
    if (!usage) throw new NotFoundException('Không tìm thấy hồ sơ người dùng.');
    return usage;
  }

  @Get('notifications')
  @AnyRole()
  async notifications(
    @CurrentAuth() auth: AuthContext,
  ): Promise<{ notifications: AppNotification[]; unread: number }> {
    return this.dashboards.alerts.list(auth.profile.uid);
  }

  @Post('notifications/read')
  @HttpCode(204)
  @AnyRole()
  async markRead(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<void> {
    const { ids } = parseOrBadRequest(markNotificationsReadRequestSchema, body ?? {});
    await this.dashboards.alerts.markRead(auth.profile.uid, ids);
  }
}

/** Cost dashboards and exports (spec 8.13). Unit Admins see their own unit only. */
@Controller('api/admin')
export class AdminUsageController {
  constructor(
    private readonly dashboards: DashboardService,
    @Inject(QUOTA_SERVICE) private readonly quota: QuotaService,
    @Inject(SETTINGS) private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {}

  private scope(auth: AuthContext, requested?: string): string | null {
    if (auth.profile.role !== 'unit_admin') return requested || null;
    const own = auth.profile.scopeDepartmentId;
    if (!own) throw new ForbiddenException('Tài khoản quản trị đơn vị chưa được gán đơn vị.');
    return own;
  }

  @Get('dashboard')
  @Roles('super_admin', 'ai_admin', 'auditor', 'unit_admin')
  async dashboard(
    @CurrentAuth() auth: AuthContext,
    @Query('period') period?: string,
    @Query('departmentId') departmentId?: string,
  ): Promise<Dashboard> {
    return this.dashboards.dashboard(periodOf(period), this.scope(auth, departmentId));
  }

  @Get('usage/export.csv')
  @Roles('super_admin', 'auditor', 'unit_admin')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="chi-phi-ai.csv"')
  async export(
    @CurrentAuth() auth: AuthContext,
    @Query('period') rawPeriod?: string,
    @Query('kind') kind = 'departments',
  ): Promise<string> {
    if (!(USAGE_EXPORT_KINDS as readonly string[]).includes(kind)) {
      throw new NotFoundException('Loại báo cáo không hợp lệ.');
    }
    const period = periodOf(rawPeriod);
    const scope = this.scope(auth);
    if (kind === 'users') {
      const rows = await this.quota.list(period, scope ?? undefined);
      return toCsv(
        [
          'ky',
          'email',
          'ho_ten',
          'ma_don_vi',
          'nhom_dinh_muc',
          'da_dung_usd',
          'dinh_muc_usd',
          'cao_cap_da_dung_usd',
        ],
        rows.map((r) => ({
          ky: period,
          email: r.email,
          ho_ten: r.name,
          ma_don_vi: r.departmentId,
          nhom_dinh_muc: QUOTA_TIER_LABELS_VI[r.tierId],
          da_dung_usd: usd(r.used),
          dinh_muc_usd: usd(r.limit),
          cao_cap_da_dung_usd: usd(r.premiumUsed),
        })),
      );
    }
    const d = await this.dashboards.dashboard(period, scope);
    const list = kind === 'models' ? d.byModel : d.byDepartment;
    const keyColumn = kind === 'models' ? 'model' : 'don_vi';
    return toCsv(
      ['ky', keyColumn, 'ten', 'so_yeu_cau', 'chi_phi_usd', 'chi_phi_vnd'],
      list.map((b) => ({
        ky: period,
        [keyColumn]: b.key,
        ten: b.label,
        so_yeu_cau: String(b.requests),
        chi_phi_usd: usd(b.cost),
        chi_phi_vnd: String(Math.round((b.cost / 1_000_000) * d.vndPerUsd)),
      })),
    );
  }

  @Get('settings/exchange-rate')
  @Roles('super_admin', 'ai_admin', 'auditor', 'unit_admin')
  async exchangeRate(): Promise<ExchangeRate> {
    return { vndPerUsd: await this.settings.exchangeRate() };
  }

  @Put('settings/exchange-rate')
  @Roles('super_admin')
  async setExchangeRate(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<ExchangeRate> {
    const { vndPerUsd } = parseOrBadRequest(exchangeRateSchema, body);
    const before = await this.settings.exchangeRate();
    await this.settings.setExchangeRate(vndPerUsd, auth.profile.uid);
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: 'settings:exchangeRate',
      metadata: { action: 'set_exchange_rate', before, after: vndPerUsd },
    });
    return { vndPerUsd };
  }
}
