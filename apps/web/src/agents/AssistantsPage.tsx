import {
  BUILTIN_TOOL_LABELS_VI,
  DLP_CONFIRM_STATUS,
  formatUsd,
  type AgentStreamEvent,
  type AgentSummary,
  type BuiltinTool,
} from '@uniai/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, fetchMyAgents, streamAgent } from '../lib/api';
import { Markdown } from '../chat/Markdown';

export interface AssistantsApi {
  fetchMyAgents: typeof fetchMyAgents;
  streamAgent: typeof streamAgent;
}
const defaultApi: AssistantsApi = { fetchMyAgents, streamAgent };
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface ToolStep {
  tool: string;
  arguments: Record<string, unknown>;
  status: 'ok' | 'error' | 'denied';
  message: string;
}
interface Turn {
  role: 'user' | 'assistant';
  content: string;
  steps: ToolStep[];
  footer?: string;
  error?: string;
}

const toolLabel = (tool: string) =>
  BUILTIN_TOOL_LABELS_VI[tool as BuiltinTool] ?? tool.replace('.', ' › ');

/** AI assistants (M18): agents configured by the university that may use tools. */
export function AssistantsPage({
  getToken,
  api = defaultApi,
}: {
  getToken: () => Promise<string>;
  api?: AssistantsApi;
}) {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((t) => api.fetchMyAgents(t))
      .then((list) => {
        if (!active) return;
        setAgents(list);
        setSelected((s) => s ?? list[0]?.id ?? null);
      })
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, getToken]);

  const agent = agents?.find((a) => a.id === selected) ?? null;
  const updateLast = (fn: (t: Turn) => Turn) =>
    setTurns((list) => [...list.slice(0, -1), fn(list.at(-1)!)]);

  function onEvent(e: AgentStreamEvent) {
    if (e.type === 'tool') {
      updateLast((t) => ({
        ...t,
        steps: [
          ...t.steps,
          { tool: e.tool, arguments: e.arguments, status: e.status, message: e.message },
        ],
      }));
    } else if (e.type === 'delta') {
      updateLast((t) => ({ ...t, content: t.content + e.text }));
    } else if (e.type === 'error') {
      updateLast((t) => ({ ...t, error: e.message }));
    } else if (e.type === 'done') {
      updateLast((t) => ({
        ...t,
        footer: `${e.steps} bước · chi phí ${formatUsd(e.cost)} · ${(e.latencyMs / 1000).toFixed(1)} giây`,
      }));
    }
  }

  async function send(text: string, acknowledged = false) {
    if (!agent || !text.trim() || busy) return;
    const history = turns
      .filter((t) => t.content && !t.error)
      .map((t) => ({ role: t.role, content: t.content }));
    const messages = [...history, { role: 'user' as const, content: text.trim() }];
    setError(null);
    setBusy(true);
    setTurns((list) => [
      ...list,
      { role: 'user', content: text.trim(), steps: [] },
      { role: 'assistant', content: '', steps: [] },
    ]);
    const controller = new AbortController();
    abort.current = controller;
    try {
      await api.streamAgent(
        await getToken(),
        agent.id,
        { messages, ...(acknowledged ? { dlpAcknowledged: true } : {}) },
        onEvent,
        controller.signal,
      );
    } catch (err) {
      setTurns((list) => list.slice(0, -2));
      if (err instanceof ApiError && err.status === DLP_CONFIRM_STATUS) {
        if (window.confirm(err.message)) {
          setBusy(false);
          await send(text, true);
          return;
        }
        setInput(text);
      } else if (!controller.signal.aborted) {
        setInput(text);
        setError(errorMessage(err));
      }
    } finally {
      abort.current = null;
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = input;
    setInput('');
    void send(text);
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
  if (agents.length === 0) {
    return <p className="text-sm text-slate-600">Chưa có trợ lý AI nào dành cho đơn vị của bạn.</p>;
  }

  return (
    <div className="flex min-h-[60vh] flex-col gap-3 md:flex-row">
      <aside aria-label="Danh sách trợ lý" className="flex flex-col gap-2 md:w-64">
        {agents.map((a) => (
          <button
            key={a.id}
            type="button"
            disabled={busy}
            className={`rounded border p-2 text-left text-sm ${a.id === selected ? 'border-sky-700 bg-sky-50' : 'border-slate-200 bg-white'}`}
            onClick={() => {
              setSelected(a.id);
              setTurns([]);
            }}
          >
            <div className="font-medium">{a.name}</div>
            {a.description && <div className="text-xs text-slate-600">{a.description}</div>}
            <div className="mt-1 text-xs text-slate-500">
              Công cụ: {a.tools.length ? a.tools.map(toolLabel).join(', ') : 'không'}
            </div>
          </button>
        ))}
      </aside>
      <section aria-label="Trò chuyện với trợ lý" className="flex flex-1 flex-col gap-3">
        <h2 className="text-lg font-semibold">{agent?.name}</h2>
        <div className="flex flex-1 flex-col gap-3">
          {turns.map((t, i) =>
            t.role === 'user' ? (
              <div
                key={i}
                className="self-end rounded bg-sky-800 px-3 py-2 text-sm whitespace-pre-wrap text-white"
              >
                {t.content}
              </div>
            ) : (
              <div key={i} className="rounded border border-slate-200 bg-white p-3 text-sm">
                {t.steps.length > 0 && (
                  <ul
                    aria-label="Các bước dùng công cụ"
                    className="mb-2 flex flex-col gap-1 text-xs text-slate-600"
                  >
                    {t.steps.map((s, j) => (
                      <li key={j}>
                        {s.status === 'ok' ? '✓' : '✗'} {toolLabel(s.tool)}
                        {Object.keys(s.arguments).length > 0 &&
                          ` (${Object.entries(s.arguments)
                            .map(([k, v]) => `${k}: ${String(v)}`)
                            .join(', ')})`}{' '}
                        – {s.message}
                      </li>
                    ))}
                  </ul>
                )}
                {t.content ? (
                  <Markdown text={t.content} />
                ) : (
                  !t.error && busy && <p className="text-slate-500">Đang xử lý…</p>
                )}
                {t.error && (
                  <p role="alert" className="text-red-700">
                    {t.error}
                  </p>
                )}
                {t.footer && <p className="mt-2 text-xs text-slate-500">{t.footer}</p>}
              </div>
            ),
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <form className="flex gap-2" onSubmit={submit}>
          <textarea
            aria-label="Câu hỏi cho trợ lý"
            className="min-h-14 flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
          />
          {busy ? (
            <button
              type="button"
              className="rounded border border-slate-300 px-3 text-sm"
              onClick={() => abort.current?.abort()}
            >
              Dừng
            </button>
          ) : (
            <button type="submit" className="rounded bg-sky-800 px-3 text-sm text-white">
              Gửi
            </button>
          )}
        </form>
      </section>
    </div>
  );
}
