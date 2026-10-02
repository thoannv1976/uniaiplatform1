import {
  AUTO_ROUTER_TIERS,
  MODEL_TIER_LABELS_VI,
  type AutoTier,
  type RouterConfig,
  type RouterTestResponse,
  type RouterView,
  type RoutingRule,
} from '@uniai/shared';
import { useEffect, useState } from 'react';
import { fetchRouter, saveRouter, testRouter } from '../lib/api';

export interface RouterApi {
  fetchRouter: typeof fetchRouter;
  saveRouter: typeof saveRouter;
  testRouter: typeof testRouter;
}
const defaultApi: RouterApi = { fetchRouter, saveRouter, testRouter };
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const field = 'rounded border border-slate-300 px-2 py-1';
const triState = (v: boolean | null) => (v === null ? '' : v ? 'yes' : 'no');
const fromTriState = (v: string) => (v === '' ? null : v === 'yes');
const intOrNull = (v: string) => (v.trim() === '' ? null : Math.max(0, Math.floor(Number(v))));

function TierSelect(props: { value: AutoTier; onChange: (t: AutoTier) => void; label: string }) {
  return (
    <select
      aria-label={props.label}
      className={field}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value as AutoTier)}
    >
      {AUTO_ROUTER_TIERS.map((t) => (
        <option key={t} value={t}>
          {MODEL_TIER_LABELS_VI[t]}
        </option>
      ))}
    </select>
  );
}

/** Smart Router (spec 8.6): rules, targets and a dry run. */
export function RouterPage({
  canEdit,
  getToken,
  api = defaultApi,
}: {
  canEdit: boolean;
  getToken: () => Promise<string>;
  api?: RouterApi;
}) {
  const [view, setView] = useState<RouterView | null>(null);
  const [draft, setDraft] = useState<RouterConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sample, setSample] = useState({ text: '', documentCount: 0, imageCount: 0 });
  const [result, setResult] = useState<RouterTestResponse | null>(null);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((t) => api.fetchRouter(t))
      .then((v) => {
        if (!active) return;
        setView(v);
        setDraft(v.config);
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

  const updateRule = (i: number, patch: Partial<RoutingRule>) =>
    setDraft({ ...draft, rules: draft.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  async function save() {
    if (!draft) return;
    setError(null);
    setNotice(null);
    try {
      const saved = await api.saveRouter(await getToken(), draft);
      setView(saved);
      setDraft(saved.config);
      setNotice('Đã lưu cấu hình định tuyến.');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function runTest() {
    setError(null);
    try {
      setResult(await api.testRouter(await getToken(), sample));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">Định tuyến thông minh (AUTO)</h2>
      {error && (
        <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {notice && <p className="rounded bg-emerald-50 p-2 text-sm text-emerald-800">{notice}</p>}

      <section aria-label="Tỷ lệ theo nhóm" className="grid grid-cols-3 gap-3 text-sm">
        {(['economy', 'standard', 'advanced'] as const).map((t) => (
          <div key={t} className="rounded-lg border border-slate-200 p-3">
            <p className="text-xs font-medium text-slate-500 uppercase">
              {MODEL_TIER_LABELS_VI[t]}
            </p>
            <p className="text-lg font-semibold tabular-nums">{view.actual[t]}%</p>
            <label className="flex items-center gap-1 text-xs text-slate-600">
              Mục tiêu
              <input
                aria-label={`Mục tiêu ${MODEL_TIER_LABELS_VI[t]}`}
                className={`${field} w-16`}
                inputMode="numeric"
                disabled={!canEdit}
                value={draft.targets[t]}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    targets: { ...draft.targets, [t]: Number(e.target.value) || 0 },
                  })
                }
              />
              %
            </label>
          </div>
        ))}
      </section>
      <p className="text-xs text-slate-500">
        Tháng {view.period.slice(4)}/{view.period.slice(0, 4)}: {view.requests} yêu cầu (cập nhật 5
        phút/lần).
      </p>

      <fieldset className="flex flex-wrap items-center gap-4 text-sm" disabled={!canEdit}>
        <label className="flex items-center gap-2">
          Nhóm mặc định
          <TierSelect
            label="Nhóm mặc định"
            value={draft.defaultTier}
            onChange={(t) => setDraft({ ...draft, defaultTier: t })}
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.enforceTargets}
            onChange={(e) => setDraft({ ...draft, enforceTargets: e.target.checked })}
          />
          Khi nhóm Nâng cao vượt mục tiêu quá 5 điểm, chuyển sang nhóm Tiêu chuẩn
        </label>
      </fieldset>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500">
            <tr>
              <th className="p-1">Bật</th>
              <th className="p-1">Tên luật</th>
              <th className="p-1">Nhóm</th>
              <th className="p-1">Ưu tiên</th>
              <th className="p-1">Từ khóa (cách nhau dấu phẩy)</th>
              <th className="p-1">Độ dài tối thiểu</th>
              <th className="p-1">Tệp / Ảnh</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.rules.map((r, i) => (
              <tr key={i} className="border-t border-slate-100 align-top">
                <td className="p-1">
                  <input
                    type="checkbox"
                    aria-label={`Bật luật ${r.name}`}
                    disabled={!canEdit}
                    checked={r.enabled}
                    onChange={(e) => updateRule(i, { enabled: e.target.checked })}
                  />
                </td>
                <td className="p-1">
                  <input
                    aria-label="Tên luật"
                    className={`${field} w-44`}
                    disabled={!canEdit}
                    value={r.name}
                    onChange={(e) => updateRule(i, { name: e.target.value })}
                  />
                </td>
                <td className="p-1">
                  <TierSelect
                    label={`Nhóm của luật ${r.name}`}
                    value={r.tier}
                    onChange={(t) => updateRule(i, { tier: t })}
                  />
                </td>
                <td className="p-1">
                  <input
                    aria-label="Ưu tiên"
                    className={`${field} w-16`}
                    inputMode="numeric"
                    disabled={!canEdit}
                    value={r.priority}
                    onChange={(e) => updateRule(i, { priority: Number(e.target.value) || 0 })}
                  />
                </td>
                <td className="p-1">
                  <textarea
                    aria-label={`Từ khóa của luật ${r.name}`}
                    className={`${field} h-16 w-72`}
                    disabled={!canEdit}
                    value={r.keywords.join(', ')}
                    onChange={(e) =>
                      updateRule(i, {
                        keywords: e.target.value
                          .split(',')
                          .map((k) => k.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </td>
                <td className="p-1">
                  <input
                    aria-label="Độ dài tối thiểu"
                    className={`${field} w-20`}
                    inputMode="numeric"
                    disabled={!canEdit}
                    value={r.minChars ?? ''}
                    onChange={(e) => updateRule(i, { minChars: intOrNull(e.target.value) })}
                  />
                </td>
                <td className="flex flex-col gap-1 p-1">
                  {(['hasFiles', 'hasImages'] as const).map((k) => (
                    <select
                      key={k}
                      aria-label={k === 'hasFiles' ? 'Điều kiện tệp' : 'Điều kiện ảnh'}
                      className={field}
                      disabled={!canEdit}
                      value={triState(r[k])}
                      onChange={(e) => updateRule(i, { [k]: fromTriState(e.target.value) })}
                    >
                      <option value="">{k === 'hasFiles' ? 'Tệp: bất kỳ' : 'Ảnh: bất kỳ'}</option>
                      <option value="yes">{k === 'hasFiles' ? 'Có tệp' : 'Có ảnh'}</option>
                      <option value="no">{k === 'hasFiles' ? 'Không tệp' : 'Không ảnh'}</option>
                    </select>
                  ))}
                </td>
                <td className="p-1">
                  {canEdit && (
                    <button
                      type="button"
                      className="text-xs text-red-700 underline"
                      onClick={() =>
                        setDraft({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })
                      }
                    >
                      Xóa
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded border border-slate-300 px-3 py-1 text-sm"
            onClick={() =>
              setDraft({
                ...draft,
                rules: [
                  ...draft.rules,
                  {
                    id: `luat-${Date.now().toString(36)}`,
                    name: 'Luật mới',
                    enabled: true,
                    priority: 10,
                    tier: 'standard',
                    keywords: [],
                    minChars: null,
                    maxChars: null,
                    hasFiles: null,
                    hasImages: null,
                  },
                ],
              })
            }
          >
            + Thêm luật
          </button>
          <button
            type="button"
            className="rounded bg-sky-800 px-4 py-1 text-sm text-white"
            onClick={() => void save()}
          >
            Lưu cấu hình
          </button>
        </div>
      )}

      {canEdit && (
        <section className="flex flex-col gap-2 border-t border-slate-200 pt-3 text-sm">
          <h3 className="font-semibold">Thử định tuyến (không gọi AI, không tốn tiền)</h3>
          <textarea
            aria-label="Câu hỏi thử"
            className={`${field} h-20`}
            value={sample.text}
            onChange={(e) => setSample({ ...sample, text: e.target.value })}
          />
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1">
              Số tệp
              <input
                className={`${field} w-14`}
                inputMode="numeric"
                value={sample.documentCount}
                onChange={(e) =>
                  setSample({ ...sample, documentCount: Number(e.target.value) || 0 })
                }
              />
            </label>
            <label className="flex items-center gap-1">
              Số ảnh
              <input
                className={`${field} w-14`}
                inputMode="numeric"
                value={sample.imageCount}
                onChange={(e) => setSample({ ...sample, imageCount: Number(e.target.value) || 0 })}
              />
            </label>
            <button
              type="button"
              className="rounded border border-slate-300 px-3 py-1"
              onClick={() => void runTest()}
            >
              Thử
            </button>
          </div>
          {result && (
            <p role="status" className="rounded bg-slate-50 p-2">
              Nhóm <strong>{MODEL_TIER_LABELS_VI[result.tier]}</strong> · model{' '}
              {result.modelName ?? 'không có model sẵn sàng'} · {result.reason}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
