import {
  DLP_ACTION_LABELS_VI,
  DLP_ACTIONS,
  DLP_DETECTOR_LABELS_VI,
  DLP_DETECTORS,
  ROLE_LABELS_VI,
  ROLES,
  type Department,
  type DlpAction,
  type DlpDetector,
  type DlpOverride,
  type DlpPolicy,
  type DlpPolicyView,
  type DlpTestResponse,
  type Role,
} from '@uniai/shared';
import { useEffect, useState } from 'react';
import { fetchDepartments, fetchDlpRules, saveDlpRules, testDlpRules } from '../lib/api';

export interface DlpApi {
  fetchDlpRules: typeof fetchDlpRules;
  saveDlpRules: typeof saveDlpRules;
  testDlpRules: typeof testDlpRules;
  fetchDepartments: typeof fetchDepartments;
}
const defaultApi: DlpApi = { fetchDlpRules, saveDlpRules, testDlpRules, fetchDepartments };
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const field = 'rounded border border-slate-300 px-2 py-1';

function ActionSelect(props: {
  value: DlpAction;
  onChange: (a: DlpAction) => void;
  label: string;
  disabled: boolean;
}) {
  return (
    <select
      aria-label={props.label}
      className={field}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value as DlpAction)}
    >
      {DLP_ACTIONS.map((a) => (
        <option key={a} value={a}>
          {DLP_ACTION_LABELS_VI[a]}
        </option>
      ))}
    </select>
  );
}

/** DLP & policy (spec 8.11): action per detector, exceptions by unit/role, and a dry run. */
export function DlpPage({
  canEdit,
  getToken,
  api = defaultApi,
}: {
  canEdit: boolean;
  getToken: () => Promise<string>;
  api?: DlpApi;
}) {
  const [view, setView] = useState<DlpPolicyView | null>(null);
  const [draft, setDraft] = useState<DlpPolicy | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sample, setSample] = useState('');
  const [result, setResult] = useState<DlpTestResponse | null>(null);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((t) => Promise.all([api.fetchDlpRules(t), api.fetchDepartments(t).catch(() => [])]))
      .then(([v, d]) => {
        if (!active) return;
        setView(v);
        setDraft(v.policy);
        setDepartments(d);
      })
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, getToken]);

  if (!view || !draft) {
    return error ? (
      <p role="alert" className="text-sm text-red-700">
        {error}
      </p>
    ) : (
      <p>Đang tải…</p>
    );
  }

  const deptName = new Map(departments.map((d) => [d.id, d.name]));
  const updateOverride = (i: number, patch: Partial<DlpOverride>) =>
    setDraft({
      ...draft,
      overrides: draft.overrides.map((o, j) => (j === i ? { ...o, ...patch } : o)),
    });

  async function save() {
    if (!draft) return;
    setError(null);
    setNotice(null);
    try {
      const saved = await api.saveDlpRules(await getToken(), draft);
      setView(saved);
      setDraft(saved.policy);
      setNotice('Đã lưu chính sách DLP (áp dụng trong vòng 30 giây).');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function runTest() {
    setError(null);
    try {
      setResult(await api.testDlpRules(await getToken(), sample));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">Bảo vệ dữ liệu (DLP)</h2>
      <p className="text-sm text-slate-600">
        Mọi tin nhắn và tệp đính kèm được kiểm tra trước khi gửi tới AI. Nhật ký chỉ ghi loại dữ
        liệu và số lượng, không ghi giá trị.
      </p>
      {error && (
        <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {notice && <p className="rounded bg-emerald-50 p-2 text-sm text-emerald-800">{notice}</p>}

      <section aria-label="Hành động mặc định" className="flex flex-col gap-2">
        <h3 className="font-medium">Hành động mặc định</h3>
        <table className="text-sm">
          <tbody>
            {DLP_DETECTORS.map((d) => (
              <tr key={d} className="border-t border-slate-200">
                <td className="py-1 pr-4">{DLP_DETECTOR_LABELS_VI[d]}</td>
                <td className="py-1">
                  <ActionSelect
                    label={`Hành động cho ${DLP_DETECTOR_LABELS_VI[d]}`}
                    value={draft.defaults[d]}
                    disabled={!canEdit}
                    onChange={(a) =>
                      setDraft({ ...draft, defaults: { ...draft.defaults, [d]: a } })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section aria-label="Ngoại lệ" className="flex flex-col gap-2">
        <h3 className="font-medium">Ngoại lệ theo đơn vị / vai trò</h3>
        <p className="text-xs text-slate-600">
          Ngoại lệ đầu tiên khớp được áp dụng thay cho hành động mặc định; đơn vị gồm cả đơn vị con.
          Để trống đơn vị hoặc vai trò = áp dụng cho tất cả.
        </p>
        {draft.overrides.length === 0 && (
          <p className="text-sm text-slate-500">Chưa có ngoại lệ.</p>
        )}
        {draft.overrides.map((o, i) => (
          <div
            key={i}
            className="flex flex-wrap items-start gap-2 rounded border border-slate-200 p-2 text-sm"
          >
            <select
              aria-label={`Loại dữ liệu ngoại lệ ${i + 1}`}
              className={field}
              value={o.detector}
              disabled={!canEdit}
              onChange={(e) => updateOverride(i, { detector: e.target.value as DlpDetector })}
            >
              {DLP_DETECTORS.map((d) => (
                <option key={d} value={d}>
                  {DLP_DETECTOR_LABELS_VI[d]}
                </option>
              ))}
            </select>
            <ActionSelect
              label={`Hành động ngoại lệ ${i + 1}`}
              value={o.action}
              disabled={!canEdit}
              onChange={(a) => updateOverride(i, { action: a })}
            />
            <select
              multiple
              aria-label={`Đơn vị ngoại lệ ${i + 1}`}
              className={`${field} h-20 min-w-40`}
              value={o.departmentIds}
              disabled={!canEdit}
              onChange={(e) =>
                updateOverride(i, {
                  departmentIds: Array.from(e.target.selectedOptions, (x) => x.value),
                })
              }
            >
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
              {o.departmentIds
                .filter((id) => !deptName.has(id))
                .map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
            </select>
            <select
              multiple
              aria-label={`Vai trò ngoại lệ ${i + 1}`}
              className={`${field} h-20`}
              value={o.roles}
              disabled={!canEdit}
              onChange={(e) =>
                updateOverride(i, {
                  roles: Array.from(e.target.selectedOptions, (x) => x.value as Role),
                })
              }
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS_VI[r]}
                </option>
              ))}
            </select>
            <input
              aria-label={`Ghi chú ngoại lệ ${i + 1}`}
              className={`${field} flex-1`}
              placeholder="Ghi chú (ví dụ: Phòng Đào tạo cần xử lý điểm)"
              value={o.note}
              maxLength={200}
              disabled={!canEdit}
              onChange={(e) => updateOverride(i, { note: e.target.value })}
            />
            {canEdit && (
              <button
                type="button"
                className="text-red-700 underline"
                onClick={() =>
                  setDraft({ ...draft, overrides: draft.overrides.filter((_, j) => j !== i) })
                }
              >
                Xóa
              </button>
            )}
          </div>
        ))}
        {canEdit && (
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-slate-300 px-3 py-1 text-sm"
              onClick={() =>
                setDraft({
                  ...draft,
                  overrides: [
                    ...draft.overrides,
                    {
                      detector: 'student_data',
                      action: 'allow',
                      departmentIds: [],
                      roles: [],
                      note: '',
                    },
                  ],
                })
              }
            >
              + Thêm ngoại lệ
            </button>
            <button
              type="button"
              className="rounded bg-sky-800 px-3 py-1 text-sm text-white"
              onClick={() => void save()}
            >
              Lưu chính sách
            </button>
          </div>
        )}
        {view.updatedAt && (
          <p className="text-xs text-slate-500">
            Cập nhật lần cuối {new Date(view.updatedAt).toLocaleString('vi-VN')}
          </p>
        )}
      </section>

      {canEdit && (
        <section aria-label="Thử chính sách" className="flex flex-col gap-2">
          <h3 className="font-medium">Thử với một đoạn văn bản</h3>
          <textarea
            aria-label="Văn bản thử"
            className={`${field} min-h-20 text-sm`}
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            placeholder="Dán đoạn văn bản mẫu (không lưu, không gửi tới AI)"
          />
          <button
            type="button"
            className="self-start rounded border border-slate-300 px-3 py-1 text-sm"
            onClick={() => void runTest()}
          >
            Kiểm tra
          </button>
          {result && (
            <div className="rounded bg-slate-50 p-2 text-sm" aria-label="Kết quả thử">
              <p>
                Kết quả: <strong>{DLP_ACTION_LABELS_VI[result.action]}</strong>
                {result.findings.length === 0 && ' – không phát hiện dữ liệu nhạy cảm'}
              </p>
              {result.findings.length > 0 && (
                <ul className="list-disc pl-5">
                  {result.findings.map((f, i) => (
                    <li key={i}>
                      {DLP_DETECTOR_LABELS_VI[f.detector]}: {DLP_ACTION_LABELS_VI[f.action]}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 whitespace-pre-wrap text-slate-700">
                Sau khi che: {result.masked}
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
