import { formatUsd, quotaPeriodOf, QUOTA_TIER_LABELS_VI, type MyUsage } from '@uniai/shared';
import { useEffect, useState } from 'react';
import { fetchMyUsage } from '../lib/api';
import { BarList, DailyColumns, Money, periodLabel, recentPeriods, Tile } from './charts';

export interface MyUsageApi {
  fetchMyUsage: typeof fetchMyUsage;
}
const defaultApi: MyUsageApi = { fetchMyUsage };
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** "My usage" (spec 8.13): this month's spend against the quota, by model and by day. */
export function MyUsagePage({
  getToken,
  api = defaultApi,
  now = new Date(),
}: {
  getToken: () => Promise<string>;
  api?: MyUsageApi;
  now?: Date;
}) {
  const current = quotaPeriodOf(now);
  const [period, setPeriod] = useState(current);
  const [usage, setUsage] = useState<MyUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((t) => api.fetchMyUsage(t, period))
      .then((u) => {
        if (!active) return;
        setUsage(u);
        setError(null);
      })
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, getToken, period]);

  const u = usage?.period === period ? usage : null;
  const q = u?.quota;
  const pct = q && q.limit > 0 ? Math.round((q.used / q.limit) * 1000) / 10 : null;
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-end gap-3">
        <h2 className="mr-auto text-xl font-semibold">Mức sử dụng của tôi</h2>
        <label className="flex flex-col text-sm">
          Kỳ
          <select
            className="rounded border border-slate-300 px-2 py-1"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          >
            {recentPeriods(current).map((p) => (
              <option key={p} value={p}>
                Tháng {periodLabel(p)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {!u && !error && <p>Đang tải…</p>}
      {u && q && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile
              label="Đã dùng"
              value={formatUsd(u.totalCost)}
              hint={<Money micro={u.totalCost} vndPerUsd={u.vndPerUsd} />}
            />
            <Tile
              label="Định mức tháng"
              value={formatUsd(q.limit)}
              hint={pct === null ? QUOTA_TIER_LABELS_VI[q.tierId] : `Đã dùng ${pct}%`}
            />
            <Tile
              label="Còn lại"
              value={formatUsd(Math.max(0, q.remaining))}
              hint={q.reserved > 0 ? `Đang giữ tạm ${formatUsd(q.reserved)}` : undefined}
            />
            <Tile label="Số yêu cầu" value={u.requests} hint={QUOTA_TIER_LABELS_VI[q.tierId]} />
          </div>
          {pct !== null && (
            <div
              className="h-2 overflow-hidden rounded bg-slate-100"
              role="progressbar"
              aria-label="Tỷ lệ định mức đã dùng"
              aria-valuenow={Math.min(100, pct)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={`h-2 ${pct >= 80 ? 'bg-amber-600' : 'bg-sky-700'}`}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
          )}
          <DailyColumns
            title="Chi phí theo ngày"
            days={u.byDay}
            period={u.period}
            vndPerUsd={u.vndPerUsd}
          />
          <BarList title="Theo model" buckets={u.byModel} vndPerUsd={u.vndPerUsd} />
          <p className="text-xs text-slate-500">
            Số liệu lấy trực tiếp từ sổ chi phí. Định mức tự làm mới ngày 1 hằng tháng; cần thêm hãy
            liên hệ quản trị đơn vị.
          </p>
        </>
      )}
    </section>
  );
}
