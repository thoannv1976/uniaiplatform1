import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
  buildMonthlyReport,
  MonthlyReportStore,
  runMonthlyReport,
  type DepartmentStore,
  type QuotaService,
} from '@uniai/firestore';
import {
  microToUsd,
  periodLabel,
  QUOTA_TIER_LABELS_VI,
  scopeReport,
  type MonthlyReportView,
  type UserProfile,
} from '@uniai/shared';
import type { Firestore } from 'firebase-admin/firestore';
import { QUOTA_SERVICE } from '../chat/chat.service.js';
import { DEPARTMENT_STORE } from '../departments/departments.controller.js';
import { FIRESTORE } from '../usage/tokens.js';
import { buildXlsx, type Sheet } from './xlsx.js';

const usd = (micro: number | null) => (micro === null ? null : microToUsd(micro));
const vnDate = (day: string) => `${day.slice(6, 8)}/${day.slice(4, 6)}/${day.slice(0, 4)}`;

/**
 * Monthly reports (spec 8.13, M16): the stored snapshot of a closed month, or figures
 * computed from the aggregates for a month without one; narrowed to a Unit Admin's unit.
 */
@Injectable()
export class ReportsService {
  private readonly store: MonthlyReportStore;

  constructor(
    @Inject(FIRESTORE) private readonly db: Firestore,
    @Inject(QUOTA_SERVICE) private readonly quota: QuotaService,
    @Inject(DEPARTMENT_STORE) private readonly departments: DepartmentStore,
  ) {
    this.store = new MonthlyReportStore(db);
  }

  /** null = whole university; Unit Admins only see their own unit. */
  scopeOf(profile: UserProfile): string | null {
    if (profile.role !== 'unit_admin') return null;
    if (!profile.scopeDepartmentId) {
      throw new ForbiddenException('Tài khoản quản trị đơn vị chưa được gán đơn vị.');
    }
    return profile.scopeDepartmentId;
  }

  async view(profile: UserProfile, period: string): Promise<MonthlyReportView> {
    const stored = await this.store.get(period);
    const report = stored ?? (await buildMonthlyReport(this.db, period));
    const root = [...(await this.departments.map()).values()].find((d) => d.parentId === null);
    return scopeReport(report, this.scopeOf(profile), root?.name ?? 'Toàn trường', !!stored);
  }

  async generate(profile: UserProfile, period: string): Promise<MonthlyReportView> {
    await runMonthlyReport(this.db, new Date(), period);
    return this.view(profile, period);
  }

  /** The report as an Excel workbook (overview, units, models, providers, tiers, days, people). */
  async xlsx(profile: UserProfile, period: string): Promise<Uint8Array> {
    const r = await this.view(profile, period);
    const people = await this.quota.list(period, r.scopeDepartmentId ?? undefined);
    const vnd = (micro: number) => Math.round(microToUsd(micro) * r.vndPerUsd);
    const intro = [
      `Báo cáo chi phí AI – ${r.scopeName} – tháng ${periodLabel(period)}`,
      r.stored
        ? `Báo cáo tháng ${r.final ? 'đã chốt' : 'tạm tính'}, tạo lúc ${new Date(r.generatedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`
        : `Số liệu tạm tính từ bảng tổng hợp (cập nhật 5 phút/lần), lấy lúc ${new Date(r.generatedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`,
      `Tỷ giá hiển thị: ${r.vndPerUsd.toLocaleString('vi-VN')} ₫/USD (VND chỉ để tham khảo)`,
    ];
    const buckets = (name: string, keyHeader: string, list: MonthlyReportView['byModel']) => ({
      name,
      intro,
      columns: [
        { header: keyHeader, width: 22 },
        { header: 'Tên', width: 30 },
        { header: 'Chi phí (USD)', format: 'usd' as const },
        { header: 'Chi phí (VND)', format: 'integer' as const },
        { header: 'Số yêu cầu', format: 'integer' as const },
      ],
      rows: list.map((b) => [b.key, b.label, usd(b.cost), vnd(b.cost), b.requests]),
    });
    const sheets: Sheet[] = [
      {
        name: 'Tổng quan',
        intro,
        columns: [
          { header: 'Chỉ số', width: 34 },
          { header: 'Giá trị', width: 20 },
        ],
        rows: [
          ['Tổng chi phí (USD)', usd(r.totalCost)],
          ['Tổng chi phí (VND)', vnd(r.totalCost)],
          ['Ngân sách (USD)', usd(r.budget)],
          ['Đã dùng (% ngân sách)', r.percentOfBudget],
          ['Số yêu cầu', r.requests],
          ['Token vào', r.inputTokens],
          ['Token ra', r.outputTokens],
          ...(r.scopeDepartmentId === null
            ? [['Người dùng hoạt động', r.activeUsers] as [string, number]]
            : []),
        ],
      },
      {
        name: 'Đơn vị',
        intro,
        columns: [
          { header: 'Mã đơn vị', width: 14 },
          { header: 'Tên đơn vị', width: 40 },
          { header: 'Đơn vị cha', width: 14 },
          { header: 'Chi phí (USD)', format: 'usd' },
          { header: 'Chi phí (VND)', format: 'integer' },
          { header: 'Ngân sách (USD)', format: 'usd' },
          { header: 'Định mức đã cấp (USD)', format: 'usd', width: 22 },
          { header: '% ngân sách', format: 'percent' },
          { header: 'Số yêu cầu', format: 'integer' },
          { header: 'Token vào', format: 'integer' },
          { header: 'Token ra', format: 'integer' },
        ],
        rows: r.departments.map((d) => [
          d.id,
          `${'   '.repeat(d.depth)}${d.name}`,
          d.parentId,
          usd(d.cost),
          vnd(d.cost),
          usd(d.budget),
          usd(d.allocated),
          d.percentOfBudget,
          d.requests,
          d.inputTokens,
          d.outputTokens,
        ]),
      },
      buckets('Model', 'Mã model', r.byModel),
      buckets('Nhà cung cấp', 'Nhà cung cấp', r.byProvider),
      buckets('Nhóm model', 'Nhóm', r.byTier),
      {
        name: 'Theo ngày',
        intro,
        columns: [
          { header: 'Ngày', width: 12 },
          { header: 'Chi phí (USD)', format: 'usd' },
          { header: 'Số yêu cầu', format: 'integer' },
          ...(r.scopeDepartmentId === null
            ? [{ header: 'Người dùng', format: 'integer' as const }]
            : []),
        ],
        rows: r.byDay.map((d) => [
          vnDate(d.day),
          usd(d.cost),
          d.requests,
          ...(r.scopeDepartmentId === null ? [d.users] : []),
        ]),
      },
      {
        name: 'Người dùng',
        intro,
        columns: [
          { header: 'Email', width: 30 },
          { header: 'Họ tên', width: 26 },
          { header: 'Mã đơn vị', width: 14 },
          { header: 'Nhóm định mức', width: 18 },
          { header: 'Đã dùng (USD)', format: 'usd' },
          { header: 'Định mức (USD)', format: 'usd' },
          { header: 'Cao cấp đã dùng (USD)', format: 'usd', width: 22 },
        ],
        rows: people
          .sort((a, b) => b.used - a.used || (a.email ?? '').localeCompare(b.email ?? ''))
          .map((p) => [
            p.email,
            p.name,
            p.departmentId,
            QUOTA_TIER_LABELS_VI[p.tierId],
            usd(p.used),
            usd(p.limit),
            usd(p.premiumUsed),
          ]),
      },
    ];
    return buildXlsx(sheets);
  }
}
