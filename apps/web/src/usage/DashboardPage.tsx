import {
  formatUsd,
  quotaPeriodOf,
  type Dashboard,
  type Department,
  type Role,
  type UsageExportKind,
} from '@uniai/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { downloadUsageExport, fetchDashboard, fetchDepartments, setExchangeRate } from '../lib/api';
import { BarList, DailyColumns, Money, periodLabel, recentPeriods, Tile } from './charts';

export interface DashboardApi {
  fetchDashboard: typeof fetchDashboard;
  fetchDepartments: typeof fetchDepartments;
  downloadUsageExport: typeof downloadUsageExport;
  setExchangeRate: typeof setExchangeRate;
}

const defaultApi: DashboardApi = {
  fetchDashboard,
  fetchDepartments,
  downloadUsageExport,
  setExchangeRate,
};
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const field = 'rounded border border-slate-300 px-2 py-1';
const button = 'rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50';

const EXPORTS: { kind: UsageExportKind; label: string }[] = [
  { kind: 'departments', label: 'CSV theo đơn vị' },
  { kind: 'models', label: 'CSV theo model' },
  { kind: 'users', label: 'CSV theo người dùng' },
];

interface Props {
  role: Role;
  getToken: () => Promise<string>;
  api?: DashboardApi;
  now?: Date;
}

/** Cost dashboard (spec 8.13): university-wide, or one unit (always the own unit for Unit Admins). */
export function DashboardPage({ role, getToken, api = defaultApi, now = new Date() }: Props) {
  const current = quotaPeriodOf(now);
  const [period, setPeriod] = useState(current);
  const [departmentId, setDepartmentId] = useState('');
  const [departments, setDepartments] = useState<Department[]>([]);
  const [data, setData] = useState<{ key: string; dashboard: Dashboard } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRate] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const canPickUnit = role !== 'unit_admin';
  const canExport = role === 'super_admin' || role === 'auditor' || role === 'unit_admin';
  const key = `${period}|${departmentId}|${reload}`;

  useEffect(() => {
    if (!canPickUnit) return;
    let active = true;
    void getToken()
      .then((t) => api.fetchDepartments(t))
      .then((list) => active && setDepartments(list.filter((d) => d.status === 'active')))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, getToken, canPickUnit]);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((t) => api.fetchDashboard(t, period, departmentId || undefined))
      .then((dashboard) => {
        if (!active) return;
        setData({ key, dashboard });
        setError(null);
      })
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, getToken, period, departmentId, key]);

  const d = data?.dashboard ?? null;
  const loading = data?.key !== key && !error;

  async function exportCsv(kind: UsageExportKind) {
    try {
      await api.downloadUsageExport(await getToken(), kind, period);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function saveRate(event: FormEvent) {
    event.preventDefault();
    const value = Number(rate.replace(/[.\s]/g, ''));
    if (!Number.isInteger(value) || value < 1000) {
      setError('Tỷ giá phải là số nguyên VND cho 1 USD, ví dụ 26000.');
      return;
    }
    try {
      await api.setExchangeRate(await getToken(), value);
      setRate('');
      setNotice(`Đã đặt tỷ giá ${value.toLocaleString('vi-VN')} ₫/USD.`);
      setReload((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <h2 className="mr-auto text-xl font-semibold">Thống kê chi phí AI</h2>
        <label className="flex flex-col text-sm">
          Kỳ
          <select className={field} value={period} onChange={(e) => setPeriod(e.target.value)}>
            {recentPeriods(current).map((p) => (
              <option key={p} value={p}>
                Tháng {periodLabel(p)}
              </option>
            ))}
          </select>
        </label>
        {canPickUnit && (
          <label className="flex flex-col text-sm">
            Phạm vi
            <select
              className={field}
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
            >
              <option value="">Toàn trường</option>
              {departments.map((dep) => (
                <option key={dep.id} value={dep.id}>
                  {dep.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {notice && <p className="rounded bg-emerald-50 p-2 text-sm text-emerald-800">{notice}</p>}
      {loading && !d && <p>Đang tải…</p>}

      {d && (
        <>
          <p className="text-sm text-slate-600">
            {d.departmentName} · tháng {periodLabel(d.period)} · cập nhật{' '}
            {d.aggregatedAt
              ? new Date(d.aggregatedAt).toLocaleString('vi-VN')
              : 'chưa có (số liệu tổng hợp 5 phút/lần)'}{' '}
            · tỷ giá {d.vndPerUsd.toLocaleString('vi-VN')} ₫/USD
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile
              label="Tổng chi phí"
              value={formatUsd(d.totalCost)}
              hint={<Money micro={d.totalCost} vndPerUsd={d.vndPerUsd} />}
            />
            <Tile
              label="Ngân sách"
              value={d.budget === null ? 'Chưa đặt' : formatUsd(d.budget)}
              hint={
                d.percentOfBudget === null
                  ? 'Đặt ở trang Định mức'
                  : `Đã dùng ${d.percentOfBudget}%`
              }
            />
            <Tile
              label="Dự báo cuối tháng"
              value={formatUsd(d.forecast)}
              hint={
                d.budget !== null && d.forecast > d.budget
                  ? '⚠ Vượt ngân sách'
                  : 'Theo tốc độ 7 ngày gần nhất'
              }
            />
            <Tile
              label="Người dùng hoạt động"
              value={d.activeUsers}
              hint={`Hôm nay ${d.activeToday} · ${d.requests} yêu cầu`}
            />
          </div>
          {d.budget !== null && (
            <div
              className="h-2 overflow-hidden rounded bg-slate-100"
              role="progressbar"
              aria-label="Tỷ lệ ngân sách đã dùng"
              aria-valuenow={Math.min(100, d.percentOfBudget ?? 0)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={`h-2 ${(d.percentOfBudget ?? 0) >= 90 ? 'bg-red-700' : 'bg-sky-700'}`}
                style={{ width: `${Math.min(100, d.percentOfBudget ?? 0)}%` }}
              />
            </div>
          )}
          <DailyColumns
            title="Chi phí theo ngày"
            days={d.byDay}
            period={d.period}
            vndPerUsd={d.vndPerUsd}
          />
          <div className="grid gap-3 md:grid-cols-2">
            <BarList title="Theo nhà cung cấp" buckets={d.byProvider} vndPerUsd={d.vndPerUsd} />
            <BarList title="Theo nhóm model" buckets={d.byTier} vndPerUsd={d.vndPerUsd} />
            <BarList title="Theo model" buckets={d.byModel} vndPerUsd={d.vndPerUsd} />
            <BarList
              title="Xếp hạng đơn vị trực thuộc"
              buckets={d.byDepartment}
              vndPerUsd={d.vndPerUsd}
            />
          </div>
          <p className="text-xs text-slate-500">
            Token: vào {d.inputTokens.toLocaleString('vi-VN')} (cache{' '}
            {d.cachedTokens.toLocaleString('vi-VN')}) · ra {d.outputTokens.toLocaleString('vi-VN')}.
            Chi phí VND chỉ để tham khảo, quy đổi theo tỷ giá cấu hình.
          </p>
        </>
      )}

      {canExport && (
        <div className="flex flex-wrap items-end gap-3 border-t border-slate-200 pt-3">
          {EXPORTS.map((e) => (
            <button
              key={e.kind}
              type="button"
              className={button}
              onClick={() => void exportCsv(e.kind)}
            >
              {e.label}
            </button>
          ))}
          {role === 'super_admin' && (
            <form className="ml-auto flex items-end gap-2" onSubmit={(e) => void saveRate(e)}>
              <label className="flex flex-col text-sm">
                Tỷ giá (VND/USD)
                <input
                  className={`${field} w-32`}
                  inputMode="numeric"
                  value={rate}
                  placeholder={d ? String(d.vndPerUsd) : '26000'}
                  onChange={(e) => setRate(e.target.value)}
                />
              </label>
              <button type="submit" className={button} disabled={!rate.trim()}>
                Lưu tỷ giá
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
