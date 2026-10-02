import { formatUsd, formatVnd, type CostBucket, type DailyPoint } from '@uniai/shared';
import type { ReactNode } from 'react';

/** "202610" → "10/2026". */
export const periodLabel = (period: string) => `${period.slice(4)}/${period.slice(0, 4)}`;

/** The current and the five previous months, newest first. */
export function recentPeriods(current: string, count = 6): string[] {
  const out: string[] = [];
  let year = Number(current.slice(0, 4));
  let month = Number(current.slice(4, 6));
  for (let i = 0; i < count; i++) {
    out.push(`${year}${String(month).padStart(2, '0')}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return out;
}

export function Money({ micro, vndPerUsd }: { micro: number; vndPerUsd: number }) {
  return (
    <>
      {formatUsd(micro)} <span className="text-slate-500">≈ {formatVnd(micro, vndPerUsd)}</span>
    </>
  );
}

export function Tile({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-900 tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/** Horizontal bars, one hue, sorted by cost; values printed beside each bar. */
export function BarList({
  title,
  buckets,
  vndPerUsd,
  limit = 10,
}: {
  title: string;
  buckets: CostBucket[];
  vndPerUsd: number;
  limit?: number;
}) {
  const shown = buckets.slice(0, limit);
  const rest = buckets.slice(limit);
  const rows = rest.length
    ? [
        ...shown,
        {
          key: '_other',
          label: `Khác (${rest.length})`,
          cost: rest.reduce((s, b) => s + b.cost, 0),
          requests: rest.reduce((s, b) => s + b.requests, 0),
        },
      ]
    : shown;
  const max = Math.max(1, ...rows.map((b) => b.cost));
  return (
    <figure className="rounded-lg border border-slate-200 bg-white p-3">
      <figcaption className="mb-2 text-sm font-semibold text-slate-800">{title}</figcaption>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">Chưa có dữ liệu.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((b) => (
            <li
              key={b.key}
              className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-2 text-sm"
              title={`${b.label}: ${formatUsd(b.cost)} ≈ ${formatVnd(b.cost, vndPerUsd)} · ${b.requests} yêu cầu`}
            >
              <span className="truncate text-slate-700">{b.label}</span>
              <span className="h-3 rounded-r bg-slate-100" aria-hidden>
                <span
                  className="block h-3 rounded-r bg-sky-700"
                  style={{ width: `${Math.max(b.cost > 0 ? 1 : 0, (b.cost / max) * 100)}%` }}
                />
              </span>
              <span className="text-right text-slate-700 tabular-nums">{formatUsd(b.cost)}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

/** Daily cost columns for one month, with a table view for screen readers and exact values. */
export function DailyColumns({
  title,
  days,
  period,
  vndPerUsd,
}: {
  title: string;
  days: DailyPoint[];
  period: string;
  vndPerUsd: number;
}) {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(4, 6));
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const byDay = new Map(days.map((d) => [d.day, d]));
  const all = Array.from({ length: count }, (_, i) => {
    const day = `${period}${String(i + 1).padStart(2, '0')}`;
    return byDay.get(day) ?? { day, cost: 0, requests: 0, users: null };
  });
  const max = Math.max(1, ...all.map((d) => d.cost));
  return (
    <figure className="rounded-lg border border-slate-200 bg-white p-3">
      <figcaption className="mb-2 flex justify-between text-sm">
        <span className="font-semibold text-slate-800">{title}</span>
        <span className="text-slate-500">cao nhất {formatUsd(max === 1 ? 0 : max)}</span>
      </figcaption>
      <div className="flex h-32 items-end gap-0.5 border-b border-slate-300" aria-hidden>
        {all.map((d) => (
          <div
            key={d.day}
            className="group flex h-full flex-1 items-end"
            title={`Ngày ${d.day.slice(6)}: ${formatUsd(d.cost)} ≈ ${formatVnd(d.cost, vndPerUsd)} · ${d.requests} yêu cầu${d.users !== null ? ` · ${d.users} người dùng` : ''}`}
          >
            <div
              className="w-full rounded-t bg-sky-700 group-hover:bg-sky-900"
              style={{ height: `${(d.cost / max) * 100}%`, minHeight: d.cost > 0 ? 2 : 0 }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-slate-500" aria-hidden>
        <span>1</span>
        <span>{Math.ceil(count / 2)}</span>
        <span>{count}</span>
      </div>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-sky-800">Xem dạng bảng</summary>
        <table className="mt-2 w-full text-left">
          <thead className="text-slate-500">
            <tr>
              <th className="font-medium">Ngày</th>
              <th className="font-medium">Yêu cầu</th>
              <th className="font-medium">Chi phí</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {all
              .filter((d) => d.requests > 0)
              .map((d) => (
                <tr key={d.day}>
                  <td>{`${d.day.slice(6)}/${d.day.slice(4, 6)}`}</td>
                  <td>{d.requests}</td>
                  <td>
                    <Money micro={d.cost} vndPerUsd={vndPerUsd} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
