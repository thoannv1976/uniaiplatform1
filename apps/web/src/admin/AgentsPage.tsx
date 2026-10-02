import {
  BUILTIN_TOOL_LABELS_VI,
  BUILTIN_TOOLS,
  INTEGRATION_TYPE_LABELS_VI,
  MAX_AGENT_STEPS,
  upsertIntegrationRequestSchema,
  type Agent,
  type Department,
  type Integration,
  type TestOperationResponse,
  type UpsertAgentRequest,
  type UpsertIntegrationRequest,
} from '@uniai/shared';
import { useEffect, useState } from 'react';
import {
  fetchAdminAgents,
  fetchDepartments,
  fetchIntegrations,
  saveAgent,
  saveIntegration,
  setIntegrationToken,
  testIntegrationOperation,
} from '../lib/api';

export interface AgentsAdminApi {
  fetchAdminAgents: typeof fetchAdminAgents;
  saveAgent: typeof saveAgent;
  fetchIntegrations: typeof fetchIntegrations;
  saveIntegration: typeof saveIntegration;
  setIntegrationToken: typeof setIntegrationToken;
  testIntegrationOperation: typeof testIntegrationOperation;
  fetchDepartments: typeof fetchDepartments;
}
const defaultApi: AgentsAdminApi = {
  fetchAdminAgents,
  saveAgent,
  fetchIntegrations,
  saveIntegration,
  setIntegrationToken,
  testIntegrationOperation,
  fetchDepartments,
};
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const field = 'rounded border border-slate-300 px-2 py-1';
const button = 'rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50';

const EMPTY_AGENT: UpsertAgentRequest = {
  name: '',
  description: '',
  instructions: '',
  model: 'auto',
  tools: [],
  knowledgeBaseIds: [],
  publishedTo: [],
  allowApps: false,
  maxSteps: 4,
  status: 'active',
};

/** Starting point for a new integration (read-only GET operations only). */
const INTEGRATION_TEMPLATE = JSON.stringify(
  {
    name: 'LMS của Trường',
    type: 'lms',
    description: 'Theo đặc tả tích hợp đã duyệt (docs/integrations)',
    baseUrl: 'https://lms.example.edu.vn/api',
    authType: 'bearer',
    authHeader: null,
    sendActor: true,
    timeoutMs: 10000,
    status: 'disabled',
    operations: [
      {
        id: 'get_course',
        name: 'Thông tin học phần',
        description: 'Tên, số tín chỉ, giảng viên của một học phần theo mã học phần',
        method: 'GET',
        path: '/courses/{courseId}',
        parameters: [
          {
            name: 'courseId',
            in: 'path',
            type: 'string',
            description: 'Mã học phần',
            required: true,
          },
        ],
      },
    ],
  },
  null,
  2,
);

const toInput = (a: Agent): UpsertAgentRequest => ({
  name: a.name,
  description: a.description,
  instructions: a.instructions,
  model: a.model,
  tools: a.tools,
  knowledgeBaseIds: a.knowledgeBaseIds,
  publishedTo: a.publishedTo,
  allowApps: a.allowApps,
  maxSteps: a.maxSteps,
  status: a.status,
});

const toIntegrationInput = (i: Integration): UpsertIntegrationRequest => ({
  name: i.name,
  type: i.type,
  description: i.description,
  baseUrl: i.baseUrl,
  authType: i.authType,
  authHeader: i.authHeader,
  sendActor: i.sendActor,
  timeoutMs: i.timeoutMs,
  status: i.status,
  operations: i.operations,
});

/** AI Agents and integration points (M18). */
export function AgentsPage({
  canEdit,
  getToken,
  api = defaultApi,
}: {
  canEdit: boolean;
  getToken: () => Promise<string>;
  api?: AgentsAdminApi;
}) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<{ id: string | null; draft: UpsertAgentRequest } | null>(
    null,
  );
  const [kbText, setKbText] = useState('');
  const [integration, setIntegration] = useState<{ id: string; json: string } | null>(null);
  const [token, setToken] = useState<Record<string, string>>({});
  const [test, setTest] = useState<{
    key: string;
    args: string;
    result: TestOperationResponse | null;
  }>({
    key: '',
    args: '{}',
    result: null,
  });

  useEffect(() => {
    let active = true;
    void getToken()
      .then((t) =>
        Promise.all([
          api.fetchAdminAgents(t),
          api.fetchIntegrations(t),
          api.fetchDepartments(t).catch(() => [] as Department[]),
        ]),
      )
      .then(([a, i, d]) => {
        if (!active) return;
        setAgents(a);
        setIntegrations(i);
        setDepartments(d.filter((x) => x.status === 'active'));
      })
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, getToken, reload]);

  async function act(fn: (token: string) => Promise<unknown>, ok: string) {
    setError(null);
    setNotice(null);
    try {
      await fn(await getToken());
      setNotice(ok);
      setReload((n) => n + 1);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  }

  if (!agents) {
    return error ? (
      <p role="alert" className="text-sm text-red-700">
        {error}
      </p>
    ) : (
      <p>Đang tải…</p>
    );
  }

  const toolOptions = [
    ...BUILTIN_TOOLS.map((t) => ({ name: t as string, label: BUILTIN_TOOL_LABELS_VI[t] })),
    ...integrations.flatMap((i) =>
      i.operations.map((o) => ({ name: `${i.id}.${o.id}`, label: `${i.name} › ${o.name}` })),
    ),
  ];
  const deptName = new Map(departments.map((d) => [d.id, d.name]));

  async function saveIntegrationJson() {
    if (!integration) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(integration.json);
    } catch {
      setError('Cấu hình không phải JSON hợp lệ.');
      return;
    }
    const check = upsertIntegrationRequestSchema.safeParse(parsed);
    if (!check.success) {
      setError(
        check.error.issues.map((i) => `${i.path.join('.') || 'cấu hình'}: ${i.message}`).join('; '),
      );
      return;
    }
    const ok = await act(
      (t) => api.saveIntegration(t, integration.id, check.data),
      `Đã lưu tích hợp ${integration.id}.`,
    );
    if (ok) setIntegration(null);
  }

  async function runTest() {
    const [id, op] = test.key.split('.') as [string, string];
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(test.args) as Record<string, unknown>;
    } catch {
      setError('Tham số thử phải là JSON, ví dụ {"courseId": "KT101"}.');
      return;
    }
    setError(null);
    try {
      const result = await api.testIntegrationOperation(await getToken(), id, op, args);
      setTest((t) => ({ ...t, result }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-xl font-semibold">Agent AI và tích hợp</h2>
      {error && (
        <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">
          {error}
        </p>
      )}
      {notice && <p className="rounded bg-emerald-50 p-2 text-sm text-emerald-800">{notice}</p>}

      <section aria-label="Agent" className="flex flex-col gap-2">
        <h3 className="font-medium">Agent</h3>
        {agents.length === 0 && <p className="text-sm text-slate-500">Chưa có agent nào.</p>}
        <ul className="flex flex-col gap-1 text-sm">
          {agents.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-1"
            >
              <strong>{a.name}</strong>
              <span className="text-xs text-slate-500">
                {a.status === 'active' ? 'Đang dùng' : 'Tạm dừng'} · {a.tools.length} công cụ · tối
                đa {a.maxSteps} bước ·{' '}
                {a.publishedTo.length
                  ? a.publishedTo.map((d) => deptName.get(d) ?? d).join(', ')
                  : 'Toàn trường'}
                {a.allowApps ? ' · mở cho ứng dụng' : ''}
              </span>
              {canEdit && (
                <button
                  type="button"
                  className={button}
                  onClick={() => {
                    setEditing({ id: a.id, draft: toInput(a) });
                    setKbText(a.knowledgeBaseIds.join(', '));
                  }}
                >
                  Sửa
                </button>
              )}
            </li>
          ))}
        </ul>
        {canEdit && !editing && (
          <button
            type="button"
            className={`${button} self-start`}
            onClick={() => {
              setEditing({ id: null, draft: EMPTY_AGENT });
              setKbText('');
            }}
          >
            + Thêm agent
          </button>
        )}
        {editing && (
          <form
            aria-label="Cấu hình agent"
            className="flex flex-col gap-2 rounded border border-slate-200 p-3 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              const draft = {
                ...editing.draft,
                knowledgeBaseIds: kbText
                  .split(/[\s,]+/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              };
              void act(
                (t) => api.saveAgent(t, editing.id, draft),
                `Đã lưu agent ${draft.name}.`,
              ).then((ok) => ok && setEditing(null));
            }}
          >
            <input
              aria-label="Tên agent"
              className={field}
              placeholder="Tên agent"
              value={editing.draft.name}
              required
              onChange={(e) =>
                setEditing({ ...editing, draft: { ...editing.draft, name: e.target.value } })
              }
            />
            <input
              aria-label="Mô tả agent"
              className={field}
              placeholder="Mô tả ngắn cho người dùng"
              value={editing.draft.description}
              onChange={(e) =>
                setEditing({ ...editing, draft: { ...editing.draft, description: e.target.value } })
              }
            />
            <textarea
              aria-label="Chỉ dẫn"
              className={`${field} min-h-24`}
              placeholder="Chỉ dẫn: vai trò, phạm vi trả lời, khi nào dùng công cụ…"
              value={editing.draft.instructions}
              required
              onChange={(e) =>
                setEditing({
                  ...editing,
                  draft: { ...editing.draft, instructions: e.target.value },
                })
              }
            />
            <fieldset className="flex flex-wrap gap-3">
              <legend className="text-xs text-slate-600">Công cụ</legend>
              {toolOptions.map((t) => (
                <label key={t.name} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={editing.draft.tools.includes(t.name)}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        draft: {
                          ...editing.draft,
                          tools: e.target.checked
                            ? [...editing.draft.tools, t.name]
                            : editing.draft.tools.filter((x) => x !== t.name),
                        },
                      })
                    }
                  />
                  {t.label}
                </label>
              ))}
            </fieldset>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1">
                Model
                <input
                  aria-label="Model"
                  className={`${field} w-40`}
                  value={editing.draft.model}
                  onChange={(e) =>
                    setEditing({ ...editing, draft: { ...editing.draft, model: e.target.value } })
                  }
                />
              </label>
              <label className="flex items-center gap-1">
                Số bước tối đa
                <input
                  aria-label="Số bước tối đa"
                  type="number"
                  min={1}
                  max={MAX_AGENT_STEPS}
                  className={`${field} w-16`}
                  value={editing.draft.maxSteps}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      draft: {
                        ...editing.draft,
                        maxSteps: Math.max(
                          1,
                          Math.min(MAX_AGENT_STEPS, Number(e.target.value) || 1),
                        ),
                      },
                    })
                  }
                />
              </label>
              <label className="flex items-center gap-1">
                Mã kho tri thức
                <input
                  aria-label="Mã kho tri thức"
                  className={`${field} w-48`}
                  placeholder="cách nhau bởi dấu phẩy"
                  value={kbText}
                  onChange={(e) => setKbText(e.target.value)}
                />
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={editing.draft.allowApps}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      draft: { ...editing.draft, allowApps: e.target.checked },
                    })
                  }
                />
                Mở cho ứng dụng (Platform API)
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={editing.draft.status === 'active'}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      draft: { ...editing.draft, status: e.target.checked ? 'active' : 'disabled' },
                    })
                  }
                />
                Đang dùng
              </label>
            </div>
            <select
              multiple
              aria-label="Đơn vị được dùng"
              className={`${field} h-24`}
              value={editing.draft.publishedTo}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  draft: {
                    ...editing.draft,
                    publishedTo: Array.from(e.target.selectedOptions, (o) => o.value),
                  },
                })
              }
            >
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-500">Không chọn đơn vị = toàn trường được dùng.</p>
            <div className="flex gap-2">
              <button type="submit" className="rounded bg-sky-800 px-3 py-1 text-white">
                Lưu agent
              </button>
              <button type="button" className={button} onClick={() => setEditing(null)}>
                Hủy
              </button>
            </div>
          </form>
        )}
      </section>

      <section aria-label="Tích hợp" className="flex flex-col gap-2">
        <h3 className="font-medium">Điểm tích hợp (chỉ đọc)</h3>
        <p className="text-xs text-slate-600">
          Chỉ cấu hình sau khi hệ thống đã được khảo sát và có đặc tả tích hợp được duyệt
          (docs/integrations). M18 chỉ cho phép thao tác đọc (GET); dữ liệu trả về đi qua DLP trước
          khi đưa cho AI.
        </p>
        {integrations.length === 0 && (
          <p className="text-sm text-slate-500">Chưa có tích hợp nào.</p>
        )}
        <ul className="flex flex-col gap-2 text-sm">
          {integrations.map((i) => (
            <li key={i.id} className="flex flex-col gap-1 border-t border-slate-200 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{i.name}</strong>
                <span className="text-xs text-slate-500">
                  {i.id} · {INTEGRATION_TYPE_LABELS_VI[i.type]} · {i.baseUrl} ·{' '}
                  {i.status === 'active' ? 'Đang dùng' : 'Tạm dừng'} · {i.operations.length} thao
                  tác · token {i.tokenLast4 ? `…${i.tokenLast4}` : 'chưa có'}
                </span>
              </div>
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={button}
                    onClick={() => {
                      setIntegration({
                        id: i.id,
                        json: JSON.stringify(toIntegrationInput(i), null, 2),
                      });
                    }}
                  >
                    Sửa cấu hình
                  </button>
                  <input
                    aria-label={`Token mới của ${i.id}`}
                    type="password"
                    autoComplete="off"
                    className={`${field} w-56`}
                    placeholder="Token mới (chỉ ghi, không hiện lại)"
                    value={token[i.id] ?? ''}
                    onChange={(e) => setToken((t) => ({ ...t, [i.id]: e.target.value }))}
                  />
                  <button
                    type="button"
                    className={button}
                    onClick={() =>
                      void act(
                        (t) => api.setIntegrationToken(t, i.id, token[i.id] ?? ''),
                        `Đã lưu token của ${i.id}.`,
                      ).then((ok) => ok && setToken((t) => ({ ...t, [i.id]: '' })))
                    }
                  >
                    Lưu token
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {canEdit && !integration && (
          <button
            type="button"
            className={`${button} self-start`}
            onClick={() => setIntegration({ id: '', json: INTEGRATION_TEMPLATE })}
          >
            + Thêm tích hợp
          </button>
        )}
        {integration && (
          <div
            aria-label="Cấu hình tích hợp"
            className="flex flex-col gap-2 rounded border border-slate-200 p-3 text-sm"
          >
            <input
              aria-label="Mã tích hợp"
              className={`${field} w-48`}
              placeholder="mã, ví dụ lms"
              value={integration.id}
              onChange={(e) => setIntegration({ ...integration, id: e.target.value.trim() })}
            />
            <textarea
              aria-label="Cấu hình JSON"
              className={`${field} min-h-64 font-mono text-xs`}
              value={integration.json}
              onChange={(e) => setIntegration({ ...integration, json: e.target.value })}
            />
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded bg-sky-800 px-3 py-1 text-white"
                onClick={() => void saveIntegrationJson()}
              >
                Lưu tích hợp
              </button>
              <button type="button" className={button} onClick={() => setIntegration(null)}>
                Hủy
              </button>
            </div>
          </div>
        )}
        {canEdit && integrations.some((i) => i.operations.length) && (
          <div
            aria-label="Thử thao tác"
            className="flex flex-col gap-2 rounded bg-slate-50 p-3 text-sm"
          >
            <div className="flex flex-wrap gap-2">
              <select
                aria-label="Thao tác cần thử"
                className={field}
                value={test.key}
                onChange={(e) => setTest({ key: e.target.value, args: '{}', result: null })}
              >
                <option value="">– Chọn thao tác –</option>
                {integrations.flatMap((i) =>
                  i.operations.map((o) => (
                    <option key={`${i.id}.${o.id}`} value={`${i.id}.${o.id}`}>
                      {i.name} › {o.name}
                    </option>
                  )),
                )}
              </select>
              <input
                aria-label="Tham số thử (JSON)"
                className={`${field} flex-1 font-mono text-xs`}
                value={test.args}
                onChange={(e) => setTest({ ...test, args: e.target.value })}
              />
              <button
                type="button"
                className={button}
                disabled={!test.key}
                onClick={() => void runTest()}
              >
                Thử
              </button>
            </div>
            {test.result && (
              <div aria-label="Kết quả thử">
                <p>
                  {test.result.ok ? 'Thành công' : `Lỗi: ${test.result.error ?? ''}`} · HTTP{' '}
                  {test.result.status ?? '–'} · {test.result.bytes} byte · {test.result.durationMs}{' '}
                  ms
                </p>
                {test.result.preview && (
                  <pre className="mt-1 max-h-48 overflow-auto rounded bg-white p-2 text-xs whitespace-pre-wrap">
                    {test.result.preview}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
