import { Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import {
  quotaPeriodOf,
  quotaPeriodSchema,
  REPORT_EXPORT_FORMATS,
  type MonthlyReportView,
} from '@uniai/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { Roles } from '../auth/decorators.js';
import { parseOrBadRequest } from '../common/zod.js';
import { ReportsService } from './reports.service.js';
import { XLSX_MIME } from './xlsx.js';

const periodOf = (raw?: string) =>
  raw ? parseOrBadRequest(quotaPeriodSchema, raw) : quotaPeriodOf(new Date());
const generateSchema = z.object({ period: quotaPeriodSchema }).strict();
const formatSchema = z.enum(REPORT_EXPORT_FORMATS, { message: 'Định dạng không hỗ trợ' });

/** Monthly reports and the Excel export (spec 8.13, 10; M16). */
@Controller('api')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly audit: AuditService,
  ) {}

  @Get('reports/monthly')
  @Roles('super_admin', 'ai_admin', 'auditor', 'unit_admin')
  async monthly(
    @CurrentAuth() auth: AuthContext,
    @Query('period') period?: string,
  ): Promise<MonthlyReportView> {
    return this.reports.view(auth.profile, periodOf(period));
  }

  /** Builds (again) and stores the report of a month, e.g. the first one after go-live. */
  @Post('admin/reports/monthly')
  @HttpCode(200)
  @Roles('super_admin')
  async generate(
    @CurrentAuth() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<MonthlyReportView> {
    const { period } = parseOrBadRequest(generateSchema, body);
    const view = await this.reports.generate(auth.profile, period);
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: `monthlyReports/${period}`,
      metadata: { action: 'generate_monthly_report', period },
    });
    return view;
  }

  @Get('reports/export')
  @Roles('super_admin', 'auditor', 'unit_admin')
  async export(
    @CurrentAuth() auth: AuthContext,
    @Res() res: Response,
    @Query('period') rawPeriod?: string,
    @Query('format') rawFormat = 'xlsx',
  ): Promise<void> {
    const period = periodOf(rawPeriod);
    const format = parseOrBadRequest(formatSchema, rawFormat);
    const bytes = await this.reports.xlsx(auth.profile, period);
    const scope = this.reports.scopeOf(auth.profile);
    await this.audit.record({
      event: 'REPORT_EXPORT',
      actor: auth.profile.uid,
      target: `monthlyReports/${period}`,
      metadata: { period, format, scope },
    });
    res
      .status(200)
      .setHeader('Content-Type', XLSX_MIME)
      .setHeader(
        'Content-Disposition',
        `attachment; filename="bao-cao-ai-${period}${scope ? `-${scope}` : ''}.xlsx"`,
      )
      .send(Buffer.from(bytes));
  }
}
