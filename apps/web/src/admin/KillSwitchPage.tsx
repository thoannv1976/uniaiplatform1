import {
  MODEL_TIER_LABELS_VI,
  MODEL_TIERS,
  PROVIDER_IDS,
  PROVIDER_LABELS_VI,
  type KillSwitch,
  type ModelTier,
  type ModelView,
  type ProviderId,
} from '@uniai/shared';
import { useEffect, useState } from 'react';
import { fetchKillSwitch, fetchModels, updateKillSwitch } from '../lib/api';

export interface KillSwitchApi {
  fetchKillSwitch: typeof fetchKillSwitch;
  updateKillSwitch: typeof updateKillSwitch;
  fetchModels: typeof fetchModels;
}
const defaultApi: KillSwitchApi = { fetchKillSwitch, updateKillSwitch, fetchModels };
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const toggle = <T,>(list: T[], item: T) =>
  list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

type Draft = Pick<
  KillSwitch,
  'all' | 'providers' | 'models' | 'tiers' | 'reason' | 'autoBrakePercent'
>;

/** Kill switch (spec 8.8): takes effect on every API instance within 5 seconds. */
export function KillSwitchPage({
  canEdit,
  getToken,
  api = defaultApi,
}: {
  canEdit: boolean;
  getToken: () => Promise<string>;
  api?: KillSwitchApi;
}) {
  const [current, setCurrent] = useState<KillSwitch | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [models, setModels] = useState<ModelView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((t) => Promise.all([api.fetchKillSwitch(t), api.fetchModels(t)]))
      .then(([ks, list]) => {
        if (!active) return;
        setCurrent(ks);
        setDraft(ks);
        setModels(list.filter((m) => m.status === 'active'));
      })
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, getToken]);

  async function save(next: Draft) {
    setError(null);
    setNotice(null);
    try {
      const saved = await api.updateKillSwitch(await getToken(), {
        all: next.all,
        providers: next.providers,
        models: next.models,
        tiers: next.tiers,
        reason: next.reason.trim(),
        autoBrakePercent: next.autoBrakePercent,
      });
      setCurrent(saved);
      setDraft(saved);
      setNotice('Đã lưu. Mọi máy chủ API áp dụng trong vòng 5 giây.');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (!draft || !current) {
    return error ? (
      <p role="alert" className="text-sm text-red-700">
        {error}
      </p>
    ) : (
      <p>Đang tải…</p>
    );
  }
  const off =
    current.all || current.providers.length + current.models.length + current.tiers.length > 0;
  const box = 'flex items-center gap-2 text-sm';
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">Kill switch – tạm dừng AI</h2>
      <p
        role="status"
        className={`rounded p-2 text-sm ${off ? 'bg-red-50 text-red-800' : 'bg-emerald-50 text-emerald-800'}`}
      >
        {current.all
          ? `Đang TẠM DỪNG toàn bộ AI. ${current.reason}`
          : off
            ? `Đang tạm dừng một phần${current.auto ? ' (phanh khẩn cấp tự bật)' : ''}. ${current.reason}`
            : 'AI đang hoạt động bình thường.'}
        {current.updatedAt &&
          ` · cập nhật ${new Date(current.updatedAt).toLocaleString('vi-VN')} bởi ${current.updatedBy ?? '—'}`}
      </p>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {notice && <p className="rounded bg-emerald-50 p-2 text-sm text-emerald-800">{notice}</p>}

      <fieldset className="flex flex-col gap-3" disabled={!canEdit}>
        <label className={`${box} font-semibold text-red-800`}>
          <input
            type="checkbox"
            checked={draft.all}
            onChange={(e) => setDraft({ ...draft, all: e.target.checked })}
          />
          Tạm dừng TOÀN BỘ AI
        </label>
        <div className="flex flex-wrap gap-4">
          <div>
            <p className="text-sm font-medium">Nhà cung cấp</p>
            {PROVIDER_IDS.map((p: ProviderId) => (
              <label key={p} className={box}>
                <input
                  type="checkbox"
                  checked={draft.providers.includes(p)}
                  onChange={() => setDraft({ ...draft, providers: toggle(draft.providers, p) })}
                />
                {PROVIDER_LABELS_VI[p]}
              </label>
            ))}
          </div>
          <div>
            <p className="text-sm font-medium">Nhóm model</p>
            {MODEL_TIERS.map((t: ModelTier) => (
              <label key={t} className={box}>
                <input
                  type="checkbox"
                  checked={draft.tiers.includes(t)}
                  onChange={() => setDraft({ ...draft, tiers: toggle(draft.tiers, t) })}
                />
                {MODEL_TIER_LABELS_VI[t]}
              </label>
            ))}
          </div>
          <div>
            <p className="text-sm font-medium">Model</p>
            {models.map((m) => (
              <label key={m.id} className={box}>
                <input
                  type="checkbox"
                  checked={draft.models.includes(m.id)}
                  onChange={() => setDraft({ ...draft, models: toggle(draft.models, m.id) })}
                />
                {m.displayName}
              </label>
            ))}
          </div>
        </div>
        <label className="flex flex-col text-sm">
          Lý do (hiển thị cho người dùng, bắt buộc khi tạm dừng)
          <input
            className="rounded border border-slate-300 px-2 py-1"
            value={draft.reason}
            maxLength={300}
            onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
          />
        </label>
        <label className="flex flex-col text-sm">
          Phanh khẩn cấp: tự tạm dừng nhóm Nâng cao và Cao cấp khi chi phí toàn trường đạt (% ngân
          sách; để trống = tắt)
          <input
            className="w-32 rounded border border-slate-300 px-2 py-1"
            inputMode="numeric"
            value={draft.autoBrakePercent ?? ''}
            onChange={(e) =>
              setDraft({
                ...draft,
                autoBrakePercent: e.target.value.trim() === '' ? null : Number(e.target.value),
              })
            }
          />
        </label>
        {canEdit && (
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded bg-red-800 px-4 py-1 text-sm text-white"
              onClick={() => void save(draft)}
            >
              Lưu kill switch
            </button>
            <button
              type="button"
              className="rounded border border-slate-300 px-4 py-1 text-sm"
              onClick={() =>
                void save({
                  ...draft,
                  all: false,
                  providers: [],
                  models: [],
                  tiers: [],
                  reason: '',
                })
              }
            >
              Bật lại toàn bộ AI
            </button>
          </div>
        )}
      </fieldset>
    </div>
  );
}
