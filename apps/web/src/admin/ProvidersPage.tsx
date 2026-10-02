import { maskedKey, TRANSPORT_LABELS_VI, type ProviderView, type Transport } from '@uniai/shared';
import { useEffect, useState } from 'react';
import { fetchProviders, setProviderKey, updateProvider } from '../lib/api';

export interface ProvidersApi {
  fetchProviders: typeof fetchProviders;
  updateProvider: typeof updateProvider;
  setProviderKey: typeof setProviderKey;
}

const defaultApi: ProvidersApi = { fetchProviders, updateProvider, setProviderKey };
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('vi-VN') : '');

interface Props {
  /** Super Admin and AI Admin: transport, on/off, fallback order. */
  canEdit: boolean;
  /** Super Admin only (ADR 0002). */
  canSetKey: boolean;
  getToken: () => Promise<string>;
  api?: ProvidersApi;
}

function status(p: ProviderView): { text: string; className: string } {
  if (!p.enabled) return { text: 'Đang tắt', className: 'bg-slate-200 text-slate-700' };
  if (!p.ready) return { text: 'Thiếu API key', className: 'bg-amber-100 text-amber-900' };
  return { text: 'Sẵn sàng', className: 'bg-emerald-100 text-emerald-900' };
}

export function ProvidersPage({ canEdit, canSetKey, getToken, api = defaultApi }: Props) {
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((t) => api.fetchProviders(t))
      .then((list) => active && (setProviders(list), setError(null)))
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, getToken, reload]);

  async function act(fn: (token: string) => Promise<unknown>, done?: string) {
    setError(null);
    setNotice(null);
    try {
      await fn(await getToken());
      if (done) setNotice(done);
      setReload((r) => r + 1);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-semibold">Nhà cung cấp AI</h2>
        <p className="text-sm text-slate-600">
          Gemini và Claude mặc định gọi qua Vertex AI (không cần key). API key nhập ở đây được lưu
          vào Google Secret Manager và không bao giờ hiển thị lại.
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
      {providers === null && !error && <p>Đang tải…</p>}

      <ul className="grid gap-3 md:grid-cols-2">
        {providers?.map((p) => {
          const s = status(p);
          return (
            <li key={p.id} className="flex flex-col gap-2 rounded border border-slate-200 p-3">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">{p.name}</h3>
                <span className={`rounded px-2 text-xs ${s.className}`}>{s.text}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label className="flex items-center gap-1">
                  <span>Cách gọi</span>
                  <select
                    aria-label={`Cách gọi ${p.name}`}
                    className="rounded border border-slate-300 px-2 py-1"
                    value={p.transport}
                    disabled={!canEdit || p.transports.length < 2}
                    onChange={(e) => {
                      // Read now: the controlled select snaps back before the async call runs.
                      const transport = e.target.value as Transport;
                      void act((t) => api.updateProvider(t, p.id, { transport }));
                    }}
                  >
                    {p.transports.map((tr) => (
                      <option key={tr} value={tr}>
                        {TRANSPORT_LABELS_VI[tr]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-1">
                  <span>Thứ tự dự phòng</span>
                  <input
                    key={p.fallbackOrder}
                    type="number"
                    min={0}
                    max={99}
                    aria-label={`Thứ tự dự phòng ${p.name}`}
                    className="w-16 rounded border border-slate-300 px-2 py-1"
                    defaultValue={p.fallbackOrder}
                    disabled={!canEdit}
                    onBlur={(e) => {
                      const value = Number(e.target.value);
                      if (Number.isInteger(value) && value !== p.fallbackOrder) {
                        void act((t) => api.updateProvider(t, p.id, { fallbackOrder: value }));
                      }
                    }}
                  />
                </label>
                {canEdit && (
                  <button
                    type="button"
                    className="rounded border border-slate-300 px-2 py-1"
                    onClick={() =>
                      void act((t) => api.updateProvider(t, p.id, { enabled: !p.enabled }))
                    }
                  >
                    {p.enabled ? `Tắt ${p.name}` : `Bật ${p.name}`}
                  </button>
                )}
              </div>
              {p.id !== 'mock' && p.transports.includes('direct') && (
                <KeySection
                  provider={p}
                  canSetKey={canSetKey}
                  onSave={(key) =>
                    act(
                      (t) => api.setProviderKey(t, p.id, key),
                      `Đã lưu API key mới cho ${p.name}.`,
                    )
                  }
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function KeySection(props: {
  provider: ProviderView;
  canSetKey: boolean;
  onSave: (key: string) => Promise<boolean>;
}) {
  const { provider: p } = props;
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <div className="flex flex-col gap-1 border-t pt-2 text-sm">
      <p>
        API key:{' '}
        {p.key.configured ? (
          <>
            <span className="font-mono">{maskedKey(p.key.last4)}</span>{' '}
            <span className="text-xs text-slate-500">
              (cập nhật {when(p.key.updatedAt)}
              {p.key.updatedBy ? ` bởi ${p.key.updatedBy}` : ''})
            </span>
          </>
        ) : (
          <span className="text-slate-500">chưa nhập</span>
        )}
        {!p.keyRequired && (
          <span className="text-xs text-slate-500"> – chỉ dùng khi chọn gọi trực tiếp</span>
        )}
      </p>
      {props.canSetKey && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSaving(true);
            void props.onSave(key.trim()).then((ok) => {
              setSaving(false);
              if (ok) setKey('');
            });
          }}
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`API key mới cho ${p.name}`}
            placeholder={p.key.configured ? 'Nhập key mới để thay' : 'Dán API key'}
            className="min-w-56 flex-1 rounded border border-slate-300 px-2 py-1 font-mono"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            required
            minLength={20}
          />
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-sky-800 px-3 py-1 text-white disabled:opacity-50"
          >
            {saving ? 'Đang lưu…' : 'Lưu key'}
          </button>
        </form>
      )}
    </div>
  );
}
