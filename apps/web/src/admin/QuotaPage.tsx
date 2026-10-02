import {
  ADJUSTMENT_TYPES,
  ADJUSTMENT_TYPE_LABELS_VI,
  formatUsd,
  QUOTA_TIER_LABELS_VI,
  type AdjustmentType,
  type Budget,
  type Department,
  type QuotaAdjustment,
  type QuotaKind,
  type QuotaSummary,
  type QuotaTier,
} from '@uniai/shared';
import { useEffect, useState, type ReactNode } from 'react';
import {
  adjustQuota,
  fetchAdjustments,
  fetchBudgets,
  fetchDepartments,
  fetchQuotas,
  fetchQuotaTiers,
  setBudget,
  updateQuotaTier,
} from '../lib/api';
import { parseUsd } from '../lib/usd';

export interface QuotaApi {
  fetchQuotas: typeof fetchQuotas;
  adjustQuota: typeof adjustQuota;
  fetchAdjustments: typeof fetchAdjustments;
  fetchBudgets: typeof fetchBudgets;
  setBudget: typeof setBudget;
  fetchQuotaTiers: typeof fetchQuotaTiers;
  updateQuotaTier: typeof updateQuotaTier;
  fetchDepartments: typeof fetchDepartments;
}

const defaultApi: QuotaApi = {
  fetchQuotas,
  adjustQuota,
  fetchAdjustments,
  fetchBudgets,
  setBudget,
  fetchQuotaTiers,
  updateQuotaTier,
  fetchDepartments,
};
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const field = 'rounded border border-slate-300 px-2 py-1';

interface Props {
  /** Super Admin and Unit Admin: adjust people and set (sub-)unit budgets. */
  canEdit: boolean;
  /** Super Admin: change quota tiers. */
  canEditTiers: boolean;
  getToken: () => Promise<string>;
  api?: QuotaApi;
}

interface Data {
  period: string;
  quotas: QuotaSummary[];
  budgets: Budget[];
  tiers: QuotaTier[];
  adjustments: QuotaAdjustment[];
  departments: Department[];
}

/** Quotas, unit budgets and tiers (spec 8.7). Every change needs a reason and an approver. */
export function QuotaPage({ canEdit, canEditTiers, getToken, api = defaultApi }: Props) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    let active = true;
    void getToken()
      .then((t) =>
        Promise.all([
          api.fetchQuotas(t),
          api.fetchBudgets(t),
          api.fetchQuotaTiers(t),
          api.fetchAdjustments(t),
          api.fetchDepartments(t),
        ]),
      )
      .then(([q, b, tiers, adjustments, departments]) => {
        if (!active) return;
        setData({
          period: q.period,
          quotas: q.quotas,
          budgets: b.budgets,
          tiers,
          adjustments,
          departments,
        });
        setError(null);
      })
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, getToken, reload]);

  async function act(fn: (token: string) => Promise<unknown>, done: string) {
    setError(null);
    setNotice(null);
    try {
      await fn(await getToken());
      setNotice(done);
      setAdjusting(null);
      setReload((r) => r + 1);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  }

  const deptName = new Map((data?.departments ?? []).map((d) => [d.id, d.name]));
  const quotas = (data?.quotas ?? []).filter((q) =>
    `${q.name ?? ''} ${q.email ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const periodLabel = data ? `${data.period.slice(4)}/${data.period.slice(0, 4)}` : '';

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-semibold">Định mức và ngân sách – tháng {periodLabel}</h2>
        <p className="text-sm text-slate-600">
          Mỗi người có ngân sách AI tháng và hạn mức riêng cho model cao cấp (nhóm Nâng cao/Cao
          cấp). Tổng định mức của cán bộ trong một đơn vị không được vượt ngân sách đơn vị.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-emerald-800">
          {notice}
        </p>
      )}
      {!data && !error && <p>Đang tải…</p>}

      {data && (
        <>
          <Section title="Cán bộ">
            <input
              type="search"
              aria-label="Lọc cán bộ"
              placeholder="Lọc theo tên hoặc email…"
              className={`${field} mb-2 w-72 text-sm`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b text-xs text-slate-500">
                  <tr>
                    <th className="py-1 pr-2">Cán bộ</th>
                    <th className="pr-2">Nhóm</th>
                    <th className="pr-2">Đã dùng / Định mức</th>
                    <th className="pr-2">Cao cấp</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {quotas.map((q) => (
                    <QuotaRow
                      key={q.uid}
                      q={q}
                      department={
                        q.departmentId ? (deptName.get(q.departmentId) ?? q.departmentId) : '–'
                      }
                      canEdit={canEdit}
                      open={adjusting === q.uid}
                      onToggle={() => setAdjusting((v) => (v === q.uid ? null : q.uid))}
                      onAdjust={(input) =>
                        act(
                          (t) => api.adjustQuota(t, { uid: q.uid, ...input }),
                          `Đã điều chỉnh định mức của ${q.name ?? q.email ?? q.uid}.`,
                        )
                      }
                    />
                  ))}
                </tbody>
              </table>
              {quotas.length === 0 && <p className="text-sm text-slate-500">Không có cán bộ.</p>}
            </div>
          </Section>

          <Section title="Ngân sách đơn vị">
            <BudgetTable budgets={data.budgets} deptName={deptName} />
            {canEdit && (
              <BudgetForm
                departments={data.departments.filter((d) => d.status === 'active')}
                onSubmit={(departmentId, budget, reason) =>
                  act(
                    (t) => api.setBudget(t, departmentId, { budget, reason }),
                    `Đã đặt ngân sách cho ${deptName.get(departmentId) ?? departmentId}.`,
                  )
                }
              />
            )}
          </Section>

          <Section title="Nhóm định mức (áp dụng từ kỳ mới hoặc người chưa mở kỳ)">
            <TierTable
              tiers={data.tiers}
              canEdit={canEditTiers}
              onSave={(tier, patch) =>
                act((t) => api.updateQuotaTier(t, tier.id, patch), `Đã cập nhật nhóm ${tier.name}.`)
              }
            />
          </Section>

          <Section title="Lịch sử điều chỉnh">
            <ul className="flex flex-col gap-1 text-sm">
              {data.adjustments.map((a) => (
                <li key={a.id} className="border-b pb-1">
                  {new Date(a.createdAt).toLocaleString('vi-VN')} –{' '}
                  {ADJUSTMENT_TYPE_LABELS_VI[a.type]}{' '}
                  {a.kind === 'premium' ? 'hạn mức cao cấp' : 'định mức'} {formatUsd(a.amount)} (
                  {a.delta >= 0 ? '+' : ''}
                  {formatUsd(a.delta)}) cho {a.uid} – lý do: {a.reason} – duyệt: {a.approvedBy}
                  {a.expiresAt && ` – hết hạn ${new Date(a.expiresAt).toLocaleString('vi-VN')}`}
                  {a.revertedAt && ' – đã thu hồi'}
                </li>
              ))}
              {data.adjustments.length === 0 && (
                <li className="text-slate-500">Chưa có điều chỉnh.</li>
              )}
            </ul>
          </Section>
        </>
      )}
    </section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded border border-slate-200 p-3">
      <h3 className="mb-2 font-semibold">{title}</h3>
      {children}
    </div>
  );
}

function Bar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : used > 0 ? 100 : 0;
  const color = pct >= 100 ? 'bg-red-600' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-600';
  return (
    <span className="inline-block h-2 w-24 rounded bg-slate-200 align-middle" aria-hidden>
      <span className={`block h-2 rounded ${color}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

function QuotaRow(props: {
  q: QuotaSummary;
  department: string;
  canEdit: boolean;
  open: boolean;
  onToggle: () => void;
  onAdjust: (input: {
    type: AdjustmentType;
    kind: QuotaKind;
    amount: number;
    reason: string;
    approvedBy: string;
    expiresAt?: string;
  }) => Promise<boolean>;
}) {
  const { q } = props;
  const label = q.name ?? q.email ?? q.uid;
  return (
    <>
      <tr className="border-b align-top">
        <td className="py-1 pr-2">
          <div>{label}</div>
          <div className="text-xs text-slate-500">
            {q.email} · {props.department}
          </div>
        </td>
        <td className="pr-2">{QUOTA_TIER_LABELS_VI[q.tierId]}</td>
        <td className="pr-2 whitespace-nowrap">
          <Bar used={q.used} limit={q.limit} /> {formatUsd(q.used)} / {formatUsd(q.limit)}
          {q.reserved > 0 && (
            <div className="text-xs text-slate-500">đang giữ {formatUsd(q.reserved)}</div>
          )}
        </td>
        <td className="pr-2 whitespace-nowrap">
          {formatUsd(q.premiumUsed)} / {formatUsd(q.premiumLimit)}
        </td>
        <td>
          {props.canEdit && (
            <button
              type="button"
              aria-label={`Điều chỉnh ${label}`}
              className="rounded border border-slate-300 px-2"
              onClick={props.onToggle}
            >
              Điều chỉnh
            </button>
          )}
        </td>
      </tr>
      {props.open && (
        <tr className="border-b bg-slate-50">
          <td colSpan={5} className="p-2">
            <AdjustForm onSubmit={props.onAdjust} />
          </td>
        </tr>
      )}
    </>
  );
}

function AdjustForm(props: {
  onSubmit: (input: {
    type: AdjustmentType;
    kind: QuotaKind;
    amount: number;
    reason: string;
    approvedBy: string;
    expiresAt?: string;
  }) => Promise<boolean>;
}) {
  const [type, setType] = useState<AdjustmentType>('increase');
  const [kind, setKind] = useState<QuotaKind>('monthly');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [approvedBy, setApprovedBy] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        const micro = parseUsd(amount);
        if (micro === null) {
          setError('Số tiền phải là số USD không âm, ví dụ 1.5');
          return;
        }
        setError(null);
        void props.onSubmit({
          type,
          kind,
          amount: micro,
          reason,
          approvedBy,
          ...(type === 'increase' && expiresAt
            ? { expiresAt: new Date(expiresAt).toISOString() }
            : {}),
        });
      }}
    >
      <label className="flex flex-col">
        <span className="text-xs text-slate-500">Loại</span>
        <select
          className={field}
          value={type}
          onChange={(e) => setType(e.target.value as AdjustmentType)}
        >
          {ADJUSTMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {ADJUSTMENT_TYPE_LABELS_VI[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col">
        <span className="text-xs text-slate-500">Áp dụng cho</span>
        <select
          className={field}
          value={kind}
          onChange={(e) => setKind(e.target.value as QuotaKind)}
        >
          <option value="monthly">Định mức tháng</option>
          <option value="premium">Hạn mức model cao cấp</option>
        </select>
      </label>
      <label className="flex flex-col">
        <span className="text-xs text-slate-500">Số tiền (USD)</span>
        <input
          className={`${field} w-24`}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
      </label>
      <label className="flex flex-col">
        <span className="text-xs text-slate-500">Lý do</span>
        <input
          className={`${field} w-56`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={5}
        />
      </label>
      <label className="flex flex-col">
        <span className="text-xs text-slate-500">Người phê duyệt</span>
        <input
          className={`${field} w-40`}
          value={approvedBy}
          onChange={(e) => setApprovedBy(e.target.value)}
          required
          minLength={2}
        />
      </label>
      {type === 'increase' && (
        <label className="flex flex-col">
          <span className="text-xs text-slate-500">Hết hạn (cấp tạm, tùy chọn)</span>
          <input
            type="datetime-local"
            className={field}
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </label>
      )}
      <button type="submit" className="rounded bg-sky-800 px-3 py-1 text-white">
        Lưu điều chỉnh
      </button>
      {error && (
        <span role="alert" className="text-red-700">
          {error}
        </span>
      )}
    </form>
  );
}

function BudgetTable({ budgets, deptName }: { budgets: Budget[]; deptName: Map<string, string> }) {
  if (budgets.length === 0) {
    return <p className="text-sm text-slate-500">Chưa đặt ngân sách đơn vị nào cho tháng này.</p>;
  }
  return (
    <table className="mb-2 w-full text-left text-sm">
      <thead className="border-b text-xs text-slate-500">
        <tr>
          <th className="py-1 pr-2">Đơn vị</th>
          <th className="pr-2">Ngân sách</th>
          <th className="pr-2">Đã phân bổ cho cán bộ</th>
          <th className="pr-2">Đã dùng (cập nhật 5 phút/lần)</th>
        </tr>
      </thead>
      <tbody>
        {budgets.map((b) => (
          <tr key={b.departmentId} className="border-b">
            <td className="py-1 pr-2">{deptName.get(b.departmentId) ?? b.departmentId}</td>
            <td className="pr-2">{formatUsd(b.budget)}</td>
            <td className="pr-2">
              <Bar used={b.allocated} limit={b.budget} /> {formatUsd(b.allocated)}
            </td>
            <td className="pr-2">{formatUsd(b.usedAggregate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BudgetForm(props: {
  departments: Department[];
  onSubmit: (departmentId: string, budget: number, reason: string) => Promise<boolean>;
}) {
  const [departmentId, setDepartmentId] = useState(props.departments[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-end gap-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        const micro = parseUsd(amount);
        if (micro === null) {
          setError('Ngân sách phải là số USD không âm');
          return;
        }
        setError(null);
        void props.onSubmit(departmentId, micro, reason);
      }}
    >
      <label className="flex flex-col">
        <span className="text-xs text-slate-500">Đơn vị</span>
        <select
          aria-label="Đơn vị"
          className={field}
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
        >
          {props.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {'— '.repeat(d.path.length - 1)}
              {d.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col">
        <span className="text-xs text-slate-500">Ngân sách tháng (USD)</span>
        <input
          className={`${field} w-28`}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
      </label>
      <label className="flex flex-col">
        <span className="text-xs text-slate-500">Lý do</span>
        <input
          className={`${field} w-56`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={5}
        />
      </label>
      <button type="submit" className="rounded bg-sky-800 px-3 py-1 text-white">
        Đặt ngân sách
      </button>
      {error && (
        <span role="alert" className="text-red-700">
          {error}
        </span>
      )}
    </form>
  );
}

function TierTable(props: {
  tiers: QuotaTier[];
  canEdit: boolean;
  onSave: (
    tier: QuotaTier,
    patch: { monthlyBudget: number; premiumBudget: number; requestsPerMinute: number },
  ) => Promise<boolean>;
}) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="border-b text-xs text-slate-500">
        <tr>
          <th className="py-1 pr-2">Nhóm</th>
          <th className="pr-2">Ngân sách tháng</th>
          <th className="pr-2">Hạn mức cao cấp</th>
          <th className="pr-2">Yêu cầu/phút</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {props.tiers.map((t) => (
          <TierRow key={t.id} tier={t} canEdit={props.canEdit} onSave={props.onSave} />
        ))}
      </tbody>
    </table>
  );
}

function TierRow(props: {
  tier: QuotaTier;
  canEdit: boolean;
  onSave: (
    tier: QuotaTier,
    patch: { monthlyBudget: number; premiumBudget: number; requestsPerMinute: number },
  ) => Promise<boolean>;
}) {
  const t = props.tier;
  const [monthly, setMonthly] = useState(String(t.monthlyBudget / 1_000_000));
  const [premium, setPremium] = useState(String(t.premiumBudget / 1_000_000));
  const [rpm, setRpm] = useState(String(t.requestsPerMinute));
  if (!props.canEdit) {
    return (
      <tr className="border-b">
        <td className="py-1 pr-2">{t.name}</td>
        <td className="pr-2">{formatUsd(t.monthlyBudget)}</td>
        <td className="pr-2">{formatUsd(t.premiumBudget)}</td>
        <td className="pr-2">{t.requestsPerMinute}</td>
        <td />
      </tr>
    );
  }
  return (
    <tr className="border-b">
      <td className="py-1 pr-2">{t.name}</td>
      <td className="pr-2">
        $
        <input
          aria-label={`Ngân sách tháng ${t.name}`}
          className={`${field} w-20`}
          value={monthly}
          onChange={(e) => setMonthly(e.target.value)}
        />
      </td>
      <td className="pr-2">
        $
        <input
          aria-label={`Hạn mức cao cấp ${t.name}`}
          className={`${field} w-20`}
          value={premium}
          onChange={(e) => setPremium(e.target.value)}
        />
      </td>
      <td className="pr-2">
        <input
          aria-label={`Yêu cầu mỗi phút ${t.name}`}
          className={`${field} w-16`}
          value={rpm}
          onChange={(e) => setRpm(e.target.value)}
        />
      </td>
      <td>
        <button
          type="button"
          className="rounded border border-slate-300 px-2"
          onClick={() => {
            const monthlyBudget = parseUsd(monthly);
            const premiumBudget = parseUsd(premium);
            const requestsPerMinute = Number(rpm);
            if (
              monthlyBudget === null ||
              premiumBudget === null ||
              !Number.isInteger(requestsPerMinute)
            )
              return;
            void props.onSave(t, { monthlyBudget, premiumBudget, requestsPerMinute });
          }}
        >
          Lưu
        </button>
      </td>
    </tr>
  );
}
