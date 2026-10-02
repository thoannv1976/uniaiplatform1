import { formatUsd, quotaPeriodOf, type MonthlyReportView, type Role } from '@uniai/shared';
import { useEffect, useState } from 'react';
import { downloadMonthlyReport, fetchMonthlyReport, generateMonthlyReport } from '../lib/api';
import { BarList, Money, periodLabel, recentPeriods, Tile } from './charts';

export interface ReportsApi {
  fetchMonthlyReport: typeof fetchMonthlyReport;
  generateMonthlyReport: typeof generateMonthlyReport;
  downloadMonthlyReport: typeof downloadMonthlyReport;
}
const defaultApi: ReportsApi = { fetchMonthlyReport, generateMonthlyReport, downloadMonthlyReport };
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const field = 'rounded border border-slate-300 px-2 py-1';
const button = 'rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50';

/** Monthly report (spec 8.13, M16): university or own unit, budget use per unit, Excel export. */
export function ReportsPage({
  role,
  getToken,
  api = defaultApi,
  now = new Date(),
}: {
  role: Role;
  getToken: () => Promise<string>;
  api?: ReportsApi;
  now?: Date;
}) {
  const current = quotaPeriodOf(now);
  const periods = recentPeriods(current, 12);
  // The last closed month is the usual report.
  const [period, setPeriod] = useState(periods[1] ?? current);
  const [data, setData] = useState<{ key: string; report: MonthlyReportView } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const key = `${period}|${reload}`;
  const canExport = role === 'super_admin' || role === 'auditor' || role === 'unit_admin';

  useEffect(() => {
    let active = true;
    void getToken()
      .then((t) => api.fetchMonthlyReport(t, period))
      .then((report) => {
        if (!active) return;
        setData({ key, report });
        setError(null);
      })
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, getToken, period, key]);

  const r = data?.key === key ? data.report : null;

  async function download() {
    setError(null);
    try {
      const scope = r?.scopeDepartmentId ? `-${r.scopeDepartmentId}` : '';
      await api.downloadMonthlyReport(
        await getToken(),
        period,
        `bao-cao-ai-${period}${scope}.xlsx`,
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function generate() {
    setError(null);
    setNotice(null);
    try {
      await api.generateMonthlyReport(await getToken(), period);
      setNotice(`Đã lưu báo cáo tháng ${periodLabel(period)}.`);
      setReload((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <h2 className="mr-auto text-xl font-semibold">
          Báo cáo tháng{r ? ` – ${r.scopeName}` : ''}
        </h2>
        <label className="flex flex-col text-sm">
          Tháng
          <select className={field} value={period} onChange={(e) => setPeriod(e.target.value)}>
            {periods.map((p) => (
              <option key={p} value={p}>
                Tháng {periodLabel(p)}
              </option>
            ))}
          </select>
        </label>
        {canExport && (
          <button type="button" className={button} onClick={() => void download()}>
            Tải Excel
          </button>
        )}
        {role === 'super_admin' && (
          <button type="button" className={button} onClick={() => void generate()}>
            {r?.stored ? 'Tạo lại báo cáo' : 'Lưu báo cáo tháng'}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {notice && <p className="rounded bg-emerald-50 p-2 text-sm text-emerald-800">{notice}</p>}
      {!r && !error && <p>Đang tải…</p>}
      {r && (
        <>
          <p className="text-xs text-slate-600">
            {r.stored
              ? `Báo cáo ${r.final ? 'đã chốt' : 'tạm tính'}, tạo lúc ${new Date(r.generatedAt).toLocaleString('vi-VN')}.`
              : 'Số liệu tạm tính từ bảng tổng hợp 5 phút; báo cáo chính thức được lưu tự động ngày 1 tháng sau.'}
          </p>
          <section aria-label="Tổng quan" className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile
              label="Tổng chi phí"
              value={formatUsd(r.totalCost)}
              hint={<Money micro={r.totalCost} vndPerUsd={r.vndPerUsd} />}
            />
            <Tile
              label="Ngân sách"
              value={r.budget === null ? 'Chưa đặt' : formatUsd(r.budget)}
              hint={r.percentOfBudget === null ? undefined : `Đã dùng ${r.percentOfBudget}%`}
            />
            <Tile label="Số yêu cầu" value={r.requests.toLocaleString('vi-VN')} />
            <Tile
              label="Token vào / ra"
              value={`${r.inputTokens.toLocaleString('vi-VN')} / ${r.outputTokens.toLocaleString('vi-VN')}`}
              hint={
                r.scopeDepartmentId === null
                  ? `${r.activeUsers.toLocaleString('vi-VN')} người dùng hoạt động`
                  : undefined
              }
            />
          </section>

          <section aria-label="Theo đơn vị" className="overflow-x-auto">
            <h3 className="mb-1 font-medium">Chi phí và ngân sách theo đơn vị</h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-600">
                  <th className="py-1 pr-3">Đơn vị</th>
                  <th className="py-1 pr-3 text-right">Chi phí</th>
                  <th className="py-1 pr-3 text-right">Ngân sách</th>
                  <th className="py-1 pr-3 text-right">Định mức đã cấp</th>
                  <th className="py-1 pr-3 text-right">% ngân sách</th>
                  <th className="py-1 text-right">Yêu cầu</th>
                </tr>
              </thead>
              <tbody>
                {r.departments.map((d) => (
                  <tr key={d.id} className="border-t border-slate-200">
                    <td className="py-1 pr-3" style={{ paddingLeft: `${d.depth * 1.25}rem` }}>
                      {d.name}
                    </td>
                    <td className="py-1 pr-3 text-right tabular-nums">{formatUsd(d.cost)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">
                      {d.budget === null ? '–' : formatUsd(d.budget)}
                    </td>
                    <td className="py-1 pr-3 text-right tabular-nums">
                      {d.allocated === null ? '–' : formatUsd(d.allocated)}
                    </td>
                    <td
                      className={`py-1 pr-3 text-right tabular-nums ${(d.percentOfBudget ?? 0) >= 100 ? 'font-semibold text-red-700' : ''}`}
                    >
                      {d.percentOfBudget === null ? '–' : `${d.percentOfBudget}%`}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {d.requests.toLocaleString('vi-VN')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <div className="grid gap-4 md:grid-cols-3">
            <BarList title="Theo model" buckets={r.byModel} vndPerUsd={r.vndPerUsd} />
            <BarList title="Theo nhà cung cấp" buckets={r.byProvider} vndPerUsd={r.vndPerUsd} />
            <BarList title="Theo nhóm model" buckets={r.byTier} vndPerUsd={r.vndPerUsd} />
          </div>
        </>
      )}
    </div>
  );
}
