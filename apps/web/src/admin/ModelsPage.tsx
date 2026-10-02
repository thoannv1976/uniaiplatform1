import {
  formatUsd,
  MODEL_CAPABILITIES,
  MODEL_CAPABILITY_LABELS_VI,
  MODEL_STATUS_LABELS_VI,
  MODEL_TIERS,
  MODEL_TIER_LABELS_VI,
  microToUsd,
  PROVIDER_IDS,
  PROVIDER_LABELS_VI,
  REASONING_EFFORTS,
  type ModelCapability,
  type ModelTier,
  type ModelView,
  type Price,
  type ProviderId,
  type ReasoningEffort,
  type TestModelResponse,
  type UpdateModelRequest,
} from '@uniai/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { parseUsd } from '../lib/usd';
import {
  addPrice,
  createModel,
  fetchModels,
  fetchPrices,
  seedModels,
  testModel,
  updateModel,
} from '../lib/api';

export interface ModelsApi {
  fetchModels: typeof fetchModels;
  createModel: typeof createModel;
  updateModel: typeof updateModel;
  seedModels: typeof seedModels;
  fetchPrices: typeof fetchPrices;
  addPrice: typeof addPrice;
  testModel: typeof testModel;
}

const defaultApi: ModelsApi = {
  fetchModels,
  createModel,
  updateModel,
  seedModels,
  fetchPrices,
  addPrice,
  testModel,
};
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const field = 'rounded border border-slate-300 px-2 py-1';

/** "$0.25" exactly as entered (no rounding), for prices per 1M tokens. */
export const perMTok = (micro: number | null | undefined) =>
  micro === null || micro === undefined ? '–' : `$${microToUsd(micro)}`;

export { parseUsd };

type Panel = { id: string; kind: 'edit' | 'prices' | 'test' } | null;

interface Props {
  canEdit: boolean;
  getToken: () => Promise<string>;
  api?: ModelsApi;
}

export function ModelsPage({ canEdit, getToken, api = defaultApi }: Props) {
  const [models, setModels] = useState<ModelView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [panel, setPanel] = useState<Panel>(null);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((t) => api.fetchModels(t))
      .then((list) => active && (setModels(list), setError(null)))
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

  const toggle = (id: string, kind: 'edit' | 'prices' | 'test') =>
    setPanel((p) => (p?.id === id && p.kind === kind ? null : { id, kind }));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl font-semibold">Model và bảng giá</h2>
          <p className="text-sm text-slate-600">
            Giá tính theo USD cho 1 triệu token. Đổi giá tạo bản ghi mới; yêu cầu đã tính phí giữ
            giá cũ. Model mới luôn ở trạng thái tắt – hãy bấm “Thử” để kiểm tra trước khi bật.
          </p>
        </div>
        {canEdit && (
          <button
            type="button"
            className="rounded border border-slate-300 px-3 py-1 text-sm"
            onClick={() =>
              void act(async (t) => {
                const created = await api.seedModels(t);
                setNotice(
                  created.length
                    ? `Đã thêm ${created.length} model mẫu: ${created.join(', ')}.`
                    : 'Danh mục mẫu đã có đủ.',
                );
              })
            }
          >
            Nạp danh mục mẫu
          </button>
        )}
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
      {models === null && !error && <p>Đang tải…</p>}
      {models?.length === 0 && <p>Chưa có model nào. Bấm “Nạp danh mục mẫu” để bắt đầu.</p>}

      {models && models.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-xs text-slate-500">
              <tr>
                <th className="py-1 pr-2">Model</th>
                <th className="pr-2">Nhà cung cấp</th>
                <th className="pr-2">Nhóm</th>
                <th className="pr-2">Giá vào / ra / cache</th>
                <th className="pr-2">Ngữ cảnh</th>
                <th className="pr-2">Trạng thái</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  canEdit={canEdit}
                  panel={panel?.id === m.id ? panel.kind : null}
                  onToggle={(kind) => toggle(m.id, kind)}
                  onStatus={() =>
                    void act((t) =>
                      api.updateModel(t, m.id, {
                        status: m.status === 'active' ? 'disabled' : 'active',
                      }),
                    )
                  }
                  onSave={(patch) =>
                    act((t) => api.updateModel(t, m.id, patch), `Đã lưu ${m.displayName}.`).then(
                      (ok) => ok && setPanel(null),
                    )
                  }
                  api={api}
                  getToken={getToken}
                  onPriceAdded={() => setReload((r) => r + 1)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && models && (
        <details className="rounded border border-slate-200 p-3 text-sm">
          <summary className="cursor-pointer font-medium">Thêm model</summary>
          <NewModelForm
            onSubmit={(input) => act((t) => api.createModel(t, input), `Đã thêm ${input.id}.`)}
          />
        </details>
      )}
    </section>
  );
}

function ModelRow(props: {
  model: ModelView;
  canEdit: boolean;
  panel: 'edit' | 'prices' | 'test' | null;
  onToggle: (kind: 'edit' | 'prices' | 'test') => void;
  onStatus: () => void;
  onSave: (patch: UpdateModelRequest) => Promise<unknown>;
  api: ModelsApi;
  getToken: () => Promise<string>;
  onPriceAdded: () => void;
}) {
  const m = props.model;
  const price = m.currentPrice;
  const btn = 'rounded border border-slate-300 px-2';
  return (
    <>
      <tr className={`border-b align-top ${m.status === 'disabled' ? 'text-slate-500' : ''}`}>
        <td className="py-1 pr-2">
          <div className="font-medium">{m.displayName}</div>
          <div className="font-mono text-xs text-slate-500">
            {m.id}
            {m.apiModelId !== m.id ? ` → ${m.apiModelId}` : ''}
          </div>
          {m.notes && <div className="max-w-md text-xs text-amber-800">{m.notes}</div>}
        </td>
        <td className="pr-2">{PROVIDER_LABELS_VI[m.providerId]}</td>
        <td className="pr-2">{MODEL_TIER_LABELS_VI[m.tier]}</td>
        <td className="pr-2 whitespace-nowrap">
          {price
            ? `${perMTok(price.inputPerMTok)} / ${perMTok(price.outputPerMTok)} / ${perMTok(price.cachedInputPerMTok)}`
            : 'Chưa có giá'}
          {m.nextPrice && (
            <div className="text-xs text-slate-500">
              Từ {new Date(m.nextPrice.effectiveFrom).toLocaleString('vi-VN')}:{' '}
              {perMTok(m.nextPrice.inputPerMTok)} / {perMTok(m.nextPrice.outputPerMTok)}
            </div>
          )}
        </td>
        <td className="pr-2 whitespace-nowrap">
          {m.contextWindow.toLocaleString('vi-VN')}
          <div className="text-xs text-slate-500">
            ra tối đa {m.maxOutputTokens.toLocaleString('vi-VN')}
          </div>
        </td>
        <td className="pr-2">{MODEL_STATUS_LABELS_VI[m.status]}</td>
        <td className="py-1">
          <span className="flex flex-wrap justify-end gap-1">
            {props.canEdit && (
              <>
                <button
                  type="button"
                  className={btn}
                  aria-label={`${m.status === 'active' ? 'Tắt' : 'Bật'} ${m.id}`}
                  onClick={props.onStatus}
                >
                  {m.status === 'active' ? 'Tắt' : 'Bật'}
                </button>
                <button
                  type="button"
                  className={btn}
                  aria-label={`Thử ${m.id}`}
                  onClick={() => props.onToggle('test')}
                >
                  Thử
                </button>
                <button
                  type="button"
                  className={btn}
                  aria-label={`Sửa ${m.id}`}
                  onClick={() => props.onToggle('edit')}
                >
                  Sửa
                </button>
              </>
            )}
            <button
              type="button"
              className={btn}
              aria-label={`Giá ${m.id}`}
              onClick={() => props.onToggle('prices')}
            >
              Giá
            </button>
          </span>
        </td>
      </tr>
      {props.panel && (
        <tr className="border-b bg-slate-50">
          <td colSpan={7} className="p-3">
            {props.panel === 'edit' && <EditModelForm model={m} onSubmit={props.onSave} />}
            {props.panel === 'prices' && (
              <PricesPanel
                model={m}
                canEdit={props.canEdit}
                api={props.api}
                getToken={props.getToken}
                onAdded={props.onPriceAdded}
              />
            )}
            {props.panel === 'test' && (
              <TestPanel model={m} api={props.api} getToken={props.getToken} />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function EditModelForm(props: {
  model: ModelView;
  onSubmit: (patch: UpdateModelRequest) => Promise<unknown>;
}) {
  const m = props.model;
  const [displayName, setDisplayName] = useState(m.displayName);
  const [apiModelId, setApiModelId] = useState(m.apiModelId);
  const [tier, setTier] = useState<ModelTier>(m.tier);
  const [contextWindow, setContextWindow] = useState(String(m.contextWindow));
  const [maxOutputTokens, setMaxOutputTokens] = useState(String(m.maxOutputTokens));
  const [priority, setPriority] = useState(String(m.priority));
  const [effort, setEffort] = useState<ReasoningEffort | ''>(m.defaultParams.reasoningEffort ?? '');
  const [capabilities, setCapabilities] = useState<ModelCapability[]>(m.capabilities);
  const [notes, setNotes] = useState(m.notes);
  return (
    <form
      className="grid gap-2 text-sm md:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        void props.onSubmit({
          displayName,
          apiModelId,
          tier,
          contextWindow: Number(contextWindow),
          maxOutputTokens: Number(maxOutputTokens),
          priority: Number(priority),
          capabilities,
          defaultParams: effort ? { reasoningEffort: effort } : {},
          notes,
        });
      }}
    >
      <Labeled label="Tên hiển thị">
        <input
          className={field}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
        />
      </Labeled>
      <Labeled label="Mã model của nhà cung cấp">
        <input
          className={`${field} font-mono`}
          value={apiModelId}
          onChange={(e) => setApiModelId(e.target.value)}
          required
        />
      </Labeled>
      <Labeled label="Nhóm">
        <TierSelect value={tier} onChange={setTier} />
      </Labeled>
      <Labeled label="Cửa sổ ngữ cảnh (token)">
        <input
          type="number"
          min={1}
          className={field}
          value={contextWindow}
          onChange={(e) => setContextWindow(e.target.value)}
        />
      </Labeled>
      <Labeled label="Token ra tối đa">
        <input
          type="number"
          min={1}
          className={field}
          value={maxOutputTokens}
          onChange={(e) => setMaxOutputTokens(e.target.value)}
        />
      </Labeled>
      <Labeled label="Độ ưu tiên">
        <input
          type="number"
          min={0}
          max={1000}
          className={field}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        />
      </Labeled>
      <Labeled label="Mức suy luận mặc định">
        <select
          className={field}
          value={effort}
          onChange={(e) => setEffort(e.target.value as ReasoningEffort | '')}
        >
          <option value="">Mặc định của nhà cung cấp</option>
          {REASONING_EFFORTS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </Labeled>
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="text-xs text-slate-500">Khả năng</legend>
        {MODEL_CAPABILITIES.map((c) => (
          <label key={c} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={capabilities.includes(c)}
              onChange={(e) =>
                setCapabilities((list) =>
                  e.target.checked ? [...list, c] : list.filter((x) => x !== c),
                )
              }
            />
            {MODEL_CAPABILITY_LABELS_VI[c]}
          </label>
        ))}
      </fieldset>
      <Labeled label="Ghi chú">
        <input
          className={field}
          value={notes}
          maxLength={500}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Labeled>
      <div className="flex items-end">
        <button type="submit" className="rounded bg-sky-800 px-3 py-1 text-white">
          Lưu
        </button>
      </div>
    </form>
  );
}

function PricesPanel(props: {
  model: ModelView;
  canEdit: boolean;
  api: ModelsApi;
  getToken: () => Promise<string>;
  onAdded: () => void;
}) {
  const { model, api, getToken } = props;
  const [prices, setPrices] = useState<Price[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [cached, setCached] = useState('');
  const [from, setFrom] = useState('');

  useEffect(() => {
    let active = true;
    void getToken()
      .then((t) => api.fetchPrices(t, model.id))
      .then((list) => active && setPrices(list))
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, getToken, model.id, reload]);

  async function submit() {
    setError(null);
    const inputPerMTok = parseUsd(input);
    const outputPerMTok = parseUsd(output);
    const cachedInputPerMTok = cached.trim() ? parseUsd(cached) : null;
    if (
      inputPerMTok === null ||
      outputPerMTok === null ||
      (cached.trim() && cachedInputPerMTok === null)
    ) {
      setError('Giá phải là số USD không âm, ví dụ 0.25');
      return;
    }
    try {
      await api.addPrice(await getToken(), model.id, {
        inputPerMTok,
        outputPerMTok,
        cachedInputPerMTok,
        ...(from ? { effectiveFrom: new Date(from).toISOString() } : {}),
      });
      setInput('');
      setOutput('');
      setCached('');
      setFrom('');
      setReload((r) => r + 1);
      props.onAdded();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <h3 className="font-semibold">Lịch sử giá – {model.displayName} (USD / 1 triệu token)</h3>
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {prices === null && !error && <p>Đang tải…</p>}
      {prices && (
        <table className="text-left">
          <thead className="text-xs text-slate-500">
            <tr>
              <th className="pr-3">Hiệu lực từ</th>
              <th className="pr-3">Vào</th>
              <th className="pr-3">Ra</th>
              <th className="pr-3">Cache</th>
              <th>Người nhập</th>
            </tr>
          </thead>
          <tbody>
            {prices.map((p) => (
              <tr key={p.id} className={p.id === model.currentPrice?.id ? 'font-semibold' : ''}>
                <td className="pr-3">{new Date(p.effectiveFrom).toLocaleString('vi-VN')}</td>
                <td className="pr-3">{perMTok(p.inputPerMTok)}</td>
                <td className="pr-3">{perMTok(p.outputPerMTok)}</td>
                <td className="pr-3">{perMTok(p.cachedInputPerMTok)}</td>
                <td>{p.createdBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {props.canEdit && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Labeled label="Giá vào ($/1M)">
            <input
              className={`${field} w-24`}
              inputMode="decimal"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              required
            />
          </Labeled>
          <Labeled label="Giá ra ($/1M)">
            <input
              className={`${field} w-24`}
              inputMode="decimal"
              value={output}
              onChange={(e) => setOutput(e.target.value)}
              required
            />
          </Labeled>
          <Labeled label="Giá cache ($/1M, tùy chọn)">
            <input
              className={`${field} w-24`}
              inputMode="decimal"
              value={cached}
              onChange={(e) => setCached(e.target.value)}
            />
          </Labeled>
          <Labeled label="Hiệu lực từ (bỏ trống = ngay)">
            <input
              type="datetime-local"
              className={field}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Labeled>
          <button type="submit" className="rounded bg-sky-800 px-3 py-1 text-white">
            Thêm giá
          </button>
        </form>
      )}
    </div>
  );
}

function TestPanel(props: { model: ModelView; api: ModelsApi; getToken: () => Promise<string> }) {
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestModelResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await props.api.testModel(
          await props.getToken(),
          props.model.id,
          prompt.trim() || undefined,
        ),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-xs text-slate-600">
        Gửi một câu ngắn tới {props.model.displayName} qua cấu hình hiện tại. Lệnh thử tốn chi phí
        thật (rất nhỏ), được ghi nhật ký và không trừ vào định mức của ai.
      </p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          aria-label="Câu hỏi thử"
          placeholder="Bỏ trống để dùng câu chào mặc định"
          className={`${field} min-w-64 flex-1`}
          value={prompt}
          maxLength={500}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button
          type="submit"
          disabled={running}
          className="rounded bg-sky-800 px-3 py-1 text-white disabled:opacity-50"
        >
          {running ? 'Đang gọi…' : 'Gửi thử'}
        </button>
      </form>
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {result && (
        <div
          className={`rounded border p-2 ${result.ok ? 'border-emerald-300' : 'border-red-300'}`}
        >
          <p className="font-medium">
            {result.ok ? 'Gọi thành công' : 'Gọi thất bại'} –{' '}
            {result.transport === 'vertex' ? 'Vertex AI' : 'trực tiếp'}, {result.latencyMs} ms
          </p>
          {result.error && <p className="text-red-700">{result.error.message}</p>}
          {result.text && <p className="whitespace-pre-wrap">{result.text}</p>}
          {result.usage && (
            <p className="text-xs text-slate-600">
              Token: {result.usage.inputTokens} vào + {result.usage.cachedInputTokens} cache /{' '}
              {result.usage.outputTokens} ra
              {result.cost !== null &&
                ` – chi phí ${formatUsd(result.cost)} (${result.cost} micro-USD)`}
              {result.stopReason && ` – kết thúc: ${result.stopReason}`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function NewModelForm(props: {
  onSubmit: (input: Parameters<ModelsApi['createModel']>[1]) => Promise<boolean>;
}) {
  const [id, setId] = useState('');
  const [providerId, setProviderId] = useState<ProviderId>('anthropic');
  const [apiModelId, setApiModelId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [tier, setTier] = useState<ModelTier>('standard');
  const [contextWindow, setContextWindow] = useState('200000');
  const [maxOutputTokens, setMaxOutputTokens] = useState('8192');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [cached, setCached] = useState('');
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="mt-2 grid gap-2 md:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        const inputPerMTok = parseUsd(input);
        const outputPerMTok = parseUsd(output);
        const cachedInputPerMTok = cached.trim() ? parseUsd(cached) : null;
        if (
          inputPerMTok === null ||
          outputPerMTok === null ||
          (cached.trim() && cachedInputPerMTok === null)
        ) {
          setError('Giá phải là số USD không âm, ví dụ 0.25');
          return;
        }
        setError(null);
        void props.onSubmit({
          id: id.trim(),
          providerId,
          apiModelId: apiModelId.trim() || id.trim(),
          displayName,
          tier,
          status: 'disabled',
          contextWindow: Number(contextWindow),
          maxOutputTokens: Number(maxOutputTokens),
          capabilities: ['text'],
          priority: 100,
          rateLimitPerMinute: null,
          defaultParams: {},
          notes: '',
          price: { inputPerMTok, outputPerMTok, cachedInputPerMTok },
        });
      }}
    >
      <Labeled label="Mã model (trong hệ thống)">
        <input
          className={`${field} font-mono`}
          placeholder="claude-haiku-4-5"
          value={id}
          onChange={(e) => setId(e.target.value)}
          required
        />
      </Labeled>
      <Labeled label="Nhà cung cấp">
        <select
          className={field}
          value={providerId}
          onChange={(e) => setProviderId(e.target.value as ProviderId)}
        >
          {PROVIDER_IDS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS_VI[p]}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label="Mã model của nhà cung cấp">
        <input
          className={`${field} font-mono`}
          placeholder="bỏ trống = giống mã trên"
          value={apiModelId}
          onChange={(e) => setApiModelId(e.target.value)}
        />
      </Labeled>
      <Labeled label="Tên hiển thị">
        <input
          className={field}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
        />
      </Labeled>
      <Labeled label="Nhóm">
        <TierSelect value={tier} onChange={setTier} />
      </Labeled>
      <Labeled label="Cửa sổ ngữ cảnh (token)">
        <input
          type="number"
          min={1}
          className={field}
          value={contextWindow}
          onChange={(e) => setContextWindow(e.target.value)}
        />
      </Labeled>
      <Labeled label="Token ra tối đa">
        <input
          type="number"
          min={1}
          className={field}
          value={maxOutputTokens}
          onChange={(e) => setMaxOutputTokens(e.target.value)}
        />
      </Labeled>
      <Labeled label="Giá vào ($/1M)">
        <input
          className={field}
          inputMode="decimal"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          required
        />
      </Labeled>
      <Labeled label="Giá ra ($/1M)">
        <input
          className={field}
          inputMode="decimal"
          value={output}
          onChange={(e) => setOutput(e.target.value)}
          required
        />
      </Labeled>
      <Labeled label="Giá cache ($/1M, tùy chọn)">
        <input
          className={field}
          inputMode="decimal"
          value={cached}
          onChange={(e) => setCached(e.target.value)}
        />
      </Labeled>
      <div className="flex items-end gap-2">
        <button type="submit" className="rounded bg-sky-800 px-3 py-1 text-white">
          Thêm model
        </button>
        {error && (
          <span role="alert" className="text-red-700">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}

function TierSelect(props: { value: ModelTier; onChange: (t: ModelTier) => void }) {
  return (
    <select
      className={field}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value as ModelTier)}
    >
      {MODEL_TIERS.map((t) => (
        <option key={t} value={t}>
          {MODEL_TIER_LABELS_VI[t]}
        </option>
      ))}
    </select>
  );
}

function Labeled(props: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-xs text-slate-500">{props.label}</span>
      {props.children}
    </label>
  );
}
