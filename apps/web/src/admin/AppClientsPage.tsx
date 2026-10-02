import {
  APP_SCOPE_LABELS_VI,
  APP_SCOPES,
  formatUsd,
  type AppClient,
  type AppClientView,
  type AppScope,
  type Department,
} from '@uniai/shared';
import { useEffect, useState, type FormEvent } from 'react';
import {
  createAppClient,
  fetchAppClients,
  fetchDepartments,
  rotateAppClientKey,
  updateAppClient,
} from '../lib/api';
import { parseUsd } from '../lib/usd';

export interface AppClientsApi {
  fetchAppClients: typeof fetchAppClients;
  createAppClient: typeof createAppClient;
  updateAppClient: typeof updateAppClient;
  rotateAppClientKey: typeof rotateAppClientKey;
  fetchDepartments: typeof fetchDepartments;
}
const defaultApi: AppClientsApi = {
  fetchAppClients,
  createAppClient,
  updateAppClient,
  rotateAppClientKey,
  fetchDepartments,
};
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const field = 'rounded border border-slate-300 px-2 py-1';
const button = 'rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50';

/** The key is shown once; the page keeps it only until dismissed. */
function KeyNotice({
  app,
  apiKey,
  onClose,
}: {
  app: AppClient;
  apiKey: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      role="alertdialog"
      aria-label="API key mới"
      className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm"
    >
      <p className="font-medium">
        API key của <strong>{app.name}</strong> – chỉ hiện một lần. Hãy lưu vào kho bí mật của ứng
        dụng (không gửi qua chat, email hay Issue).
      </p>
      <code className="rounded bg-white p-2 break-all select-all" data-testid="app-key">
        {apiKey}
      </code>
      <div className="flex gap-2">
        <button
          type="button"
          className={button}
          onClick={() =>
            void navigator.clipboard
              ?.writeText(apiKey)
              .then(() => setCopied(true))
              .catch(() => undefined)
          }
        >
          {copied ? 'Đã chép' : 'Chép key'}
        </button>
        <button type="button" className={button} onClick={onClose}>
          Đã lưu key, đóng
        </button>
      </div>
    </div>
  );
}

/** Platform API applications (M17): register, budget, scopes, key rotation. */
export function AppClientsPage({
  canEdit,
  getToken,
  api = defaultApi,
}: {
  canEdit: boolean;
  getToken: () => Promise<string>;
  api?: AppClientsApi;
}) {
  const [clients, setClients] = useState<AppClientView[] | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shown, setShown] = useState<{ app: AppClient; key: string } | null>(null);
  const [form, setForm] = useState({
    name: '',
    description: '',
    ownerDepartmentId: '',
    budget: '',
    requestsPerMinute: '60',
    allowAdvanced: false,
    scopes: ['chat', 'usage'] as AppScope[],
  });
  const [budgets, setBudgets] = useState<Record<string, string>>({});

  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((token) =>
        Promise.all([
          api.fetchAppClients(token),
          api.fetchDepartments(token).catch(() => [] as Department[]),
        ]),
      )
      .then(([list, depts]) => {
        if (!active) return;
        setClients(list);
        setDepartments(depts.filter((d) => d.status === 'active'));
      })
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, getToken, reload]);

  const deptName = new Map(departments.map((d) => [d.id, d.name]));

  async function act(fn: (token: string) => Promise<unknown>, ok?: string) {
    setError(null);
    setNotice(null);
    try {
      await fn(await getToken());
      if (ok) setNotice(ok);
      setReload((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    const monthlyBudget = parseUsd(form.budget);
    if (monthlyBudget === null) {
      setError('Ngân sách tháng là số USD không âm, ví dụ 20 hoặc 2.5.');
      return;
    }
    await act(async (token) => {
      const result = await api.createAppClient(token, {
        name: form.name,
        description: form.description,
        ownerDepartmentId: form.ownerDepartmentId,
        scopes: form.scopes,
        monthlyBudget,
        requestsPerMinute: Math.max(1, Math.floor(Number(form.requestsPerMinute) || 60)),
        allowAdvanced: form.allowAdvanced,
      });
      setShown({ app: result.client, key: result.key });
      setForm((f) => ({ ...f, name: '', description: '', budget: '' }));
    });
  }

  if (!clients) {
    return error ? (
      <p role="alert" className="text-sm text-red-700">
        {error}
      </p>
    ) : (
      <p>Đang tải…</p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">Ứng dụng dùng Platform API</h2>
      <p className="text-sm text-slate-600">
        Ứng dụng nội bộ (LMS, cổng thông tin…) gọi AI qua <code>/api/platform/v1</code> bằng API key
        riêng. Chi phí trừ vào ngân sách tháng của ứng dụng và tính vào đơn vị chủ quản. Hướng dẫn
        tích hợp: <code>docs/platform/README.md</code>.
      </p>
      {error && (
        <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {notice && <p className="rounded bg-emerald-50 p-2 text-sm text-emerald-800">{notice}</p>}
      {shown && <KeyNotice app={shown.app} apiKey={shown.key} onClose={() => setShown(null)} />}

      <section aria-label="Danh sách ứng dụng" className="overflow-x-auto">
        {clients.length === 0 ? (
          <p className="text-sm text-slate-500">Chưa có ứng dụng nào.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-600">
                <th className="py-1 pr-3">Ứng dụng</th>
                <th className="py-1 pr-3">Đơn vị</th>
                <th className="py-1 pr-3">Quyền</th>
                <th className="py-1 pr-3 text-right">Đã dùng / ngân sách tháng</th>
                <th className="py-1 pr-3">Key</th>
                <th className="py-1 pr-3">Trạng thái</th>
                {canEdit && <th className="py-1">Thao tác</th>}
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id} className="border-t border-slate-200 align-top">
                  <td className="py-1 pr-3">
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-slate-500">{c.id}</div>
                  </td>
                  <td className="py-1 pr-3">
                    {deptName.get(c.ownerDepartmentId) ?? c.ownerDepartmentId}
                  </td>
                  <td className="py-1 pr-3 text-xs">
                    {c.scopes.map((s) => APP_SCOPE_LABELS_VI[s]).join(', ')}
                    {c.allowAdvanced ? ' · được dùng model Nâng cao' : ''}
                    <div>{c.requestsPerMinute} yêu cầu/phút</div>
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums">
                    {formatUsd(c.used)} / {formatUsd(c.monthlyBudget)}
                    {canEdit && (
                      <div className="mt-1 flex justify-end gap-1">
                        <input
                          aria-label={`Ngân sách mới của ${c.name} (USD)`}
                          className={`${field} w-20 text-right`}
                          inputMode="decimal"
                          value={budgets[c.id] ?? ''}
                          placeholder="USD"
                          onChange={(e) => setBudgets((b) => ({ ...b, [c.id]: e.target.value }))}
                        />
                        <button
                          type="button"
                          className={button}
                          onClick={() => {
                            const v = parseUsd(budgets[c.id] ?? '');
                            if (v === null) {
                              setError('Ngân sách là số USD không âm.');
                              return;
                            }
                            void act(
                              (t) => api.updateAppClient(t, c.id, { monthlyBudget: v }),
                              `Đã đặt ngân sách ${c.name}: ${formatUsd(v)}/tháng.`,
                            ).then(() => setBudgets((b) => ({ ...b, [c.id]: '' })));
                          }}
                        >
                          Lưu
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="py-1 pr-3 font-mono text-xs">
                    …{c.keyLast4}
                    <div className="font-sans text-slate-500">
                      {c.lastUsedAt
                        ? `Dùng gần nhất ${new Date(c.lastUsedAt).toLocaleString('vi-VN')}`
                        : 'Chưa dùng'}
                    </div>
                  </td>
                  <td className="py-1 pr-3">{c.status === 'active' ? 'Đang chạy' : 'Tạm dừng'}</td>
                  {canEdit && (
                    <td className="flex flex-col gap-1 py-1">
                      <button
                        type="button"
                        className={button}
                        onClick={() => {
                          if (
                            !window.confirm(`Đổi key của ${c.name}? Key cũ ngừng hoạt động ngay.`)
                          )
                            return;
                          void act(async (t) => {
                            const r = await api.rotateAppClientKey(t, c.id);
                            setShown({ app: r.client, key: r.key });
                          });
                        }}
                      >
                        Đổi key
                      </button>
                      <button
                        type="button"
                        className={button}
                        onClick={() =>
                          void act(
                            (t) =>
                              api.updateAppClient(t, c.id, {
                                status: c.status === 'active' ? 'disabled' : 'active',
                              }),
                            c.status === 'active'
                              ? `Đã tạm dừng ${c.name}.`
                              : `Đã bật lại ${c.name}.`,
                          )
                        }
                      >
                        {c.status === 'active' ? 'Tạm dừng' : 'Bật lại'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {canEdit && (
        <form
          aria-label="Thêm ứng dụng"
          className="flex flex-col gap-2 rounded border border-slate-200 p-3 text-sm"
          onSubmit={(e) => void create(e)}
        >
          <h3 className="font-medium">Thêm ứng dụng</h3>
          <div className="flex flex-wrap gap-2">
            <input
              aria-label="Tên ứng dụng"
              className={`${field} flex-1`}
              placeholder="Tên ứng dụng (ví dụ LMS Khoa KTQT)"
              value={form.name}
              required
              maxLength={100}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <select
              aria-label="Đơn vị chủ quản"
              className={field}
              value={form.ownerDepartmentId}
              required
              onChange={(e) => setForm({ ...form, ownerDepartmentId: e.target.value })}
            >
              <option value="">– Đơn vị chủ quản –</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <input
            aria-label="Mô tả"
            className={field}
            placeholder="Mô tả, người phụ trách kỹ thuật"
            value={form.description}
            maxLength={500}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1">
              Ngân sách tháng (USD)
              <input
                aria-label="Ngân sách tháng (USD)"
                className={`${field} w-24`}
                inputMode="decimal"
                value={form.budget}
                required
                onChange={(e) => setForm({ ...form, budget: e.target.value })}
              />
            </label>
            <label className="flex items-center gap-1">
              Yêu cầu/phút
              <input
                aria-label="Yêu cầu mỗi phút"
                className={`${field} w-20`}
                inputMode="numeric"
                value={form.requestsPerMinute}
                onChange={(e) => setForm({ ...form, requestsPerMinute: e.target.value })}
              />
            </label>
            {APP_SCOPES.map((s) => (
              <label key={s} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={form.scopes.includes(s)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      scopes: e.target.checked
                        ? [...form.scopes, s]
                        : form.scopes.filter((x) => x !== s),
                    })
                  }
                />
                {APP_SCOPE_LABELS_VI[s]}
              </label>
            ))}
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={form.allowAdvanced}
                onChange={(e) => setForm({ ...form, allowAdvanced: e.target.checked })}
              />
              Cho dùng model Nâng cao/Cao cấp
            </label>
          </div>
          <button type="submit" className="self-start rounded bg-sky-800 px-3 py-1 text-white">
            Tạo ứng dụng và cấp key
          </button>
        </form>
      )}
    </div>
  );
}
