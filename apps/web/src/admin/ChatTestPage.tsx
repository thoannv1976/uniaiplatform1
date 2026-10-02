import {
  CHAT_MODEL_AUTO,
  formatUsd,
  MODEL_TIER_LABELS_VI,
  type ChatModelOption,
  type ChatStreamEvent,
  type MessageStatus,
} from '@uniai/shared';
import { useEffect, useRef, useState } from 'react';
import { fetchChatModels, streamChat } from '../lib/api';

export interface ChatTestApi {
  fetchChatModels: typeof fetchChatModels;
  streamChat: typeof streamChat;
}

const defaultApi: ChatTestApi = { fetchChatModels, streamChat };
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  model?: string;
  routeReason?: string;
  status?: MessageStatus;
  footer?: string;
  error?: string;
}

const STATUS_VI: Record<MessageStatus, string> = {
  streaming: 'đang trả lời…',
  complete: 'xong',
  cancelled: 'đã dừng',
  error: 'lỗi',
};

/**
 * Admin test bench for the AI Gateway (M5): streams answers, can stop them, shows the model,
 * tokens and cost. The full chat interface for everyone comes in M6.
 */
export function ChatTestPage({
  getToken,
  api = defaultApi,
}: {
  getToken: () => Promise<string>;
  api?: ChatTestApi;
}) {
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [model, setModel] = useState<string>(CHAT_MODEL_AUTO);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((t) => api.fetchChatModels(t))
      .then((list) => active && setModels(list))
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
      controller.current?.abort();
    };
  }, [api, getToken]);

  const updateLast = (fn: (t: Turn) => Turn) =>
    setTurns((list) => [...list.slice(0, -1), fn(list.at(-1) as Turn)]);

  function onEvent(e: ChatStreamEvent) {
    if (e.type === 'meta') {
      setConversationId(e.conversationId);
      updateLast((t) => ({ ...t, model: e.model.displayName, routeReason: e.routeReason }));
    } else if (e.type === 'citations' || e.type === 'dlp') {
      // The test page does not use knowledge bases; DLP notices are shown in the chat page.
    } else if (e.type === 'delta') {
      updateLast((t) => ({ ...t, text: t.text + e.text }));
    } else if (e.type === 'error') {
      updateLast((t) => ({ ...t, error: e.message }));
    } else {
      const usage = e.usage
        ? `${e.usage.inputTokens} vào + ${e.usage.cachedInputTokens} cache / ${e.usage.outputTokens} ra`
        : 'không có token';
      const cost = e.cost === null ? '' : ` – ${formatUsd(e.cost)} (${e.cost} micro-USD)`;
      updateLast((t) => ({
        ...t,
        status: e.status,
        footer: `${usage}${cost} – ${(e.latencyMs / 1000).toFixed(1)} giây`,
      }));
    }
  }

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setError(null);
    setInput('');
    setBusy(true);
    setTurns((list) => [
      ...list,
      { role: 'user', text: message },
      { role: 'assistant', text: '', status: 'streaming' },
    ]);
    const abort = new AbortController();
    controller.current = abort;
    try {
      await api.streamChat(
        await getToken(),
        { message, model, ...(conversationId ? { conversationId } : {}) },
        onEvent,
        abort.signal,
      );
    } catch (err) {
      if (abort.signal.aborted) {
        updateLast((t) => ({
          ...t,
          status: 'cancelled',
          footer: 'Đã dừng – chi phí phần đã sinh vẫn được ghi.',
        }));
      } else {
        setTurns((list) => list.slice(0, -1));
        setError(errorMessage(err));
      }
    } finally {
      controller.current = null;
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl font-semibold">Thử chat (AI Gateway)</h2>
          <p className="text-sm text-slate-600">
            Trang kiểm tra cho quản trị viên. Trên staging, gõ <code>[mock:slow=75]</code> với model
            Mock để thử câu trả lời dài hơn 60 giây, <code>[mock:fail=429]</code> để thử lỗi.
          </p>
        </div>
        <button
          type="button"
          className="rounded border border-slate-300 px-3 py-1 text-sm"
          disabled={busy}
          onClick={() => {
            setConversationId(null);
            setTurns([]);
          }}
        >
          Hội thoại mới
        </button>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <span>Model</span>
        <select
          aria-label="Model"
          className="rounded border border-slate-300 px-2 py-1"
          value={model}
          disabled={busy}
          onChange={(e) => setModel(e.target.value)}
        >
          <option value={CHAT_MODEL_AUTO}>AUTO (hệ thống tự chọn)</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName} – {MODEL_TIER_LABELS_VI[m.tier]}
            </option>
          ))}
        </select>
        {conversationId && (
          <span className="font-mono text-xs text-slate-500">hội thoại {conversationId}</span>
        )}
      </label>

      <ol className="flex flex-col gap-2" aria-label="Hội thoại">
        {turns.map((t, i) => (
          <li
            key={i}
            className={`rounded p-2 text-sm ${t.role === 'user' ? 'self-end bg-sky-50' : 'border border-slate-200'}`}
          >
            {t.role === 'assistant' && (
              <div className="mb-1 text-xs text-slate-500">
                {t.model ?? '…'}
                {t.routeReason ? ` – ${t.routeReason}` : ''}
                {t.status ? ` – ${STATUS_VI[t.status]}` : ''}
              </div>
            )}
            <p className="whitespace-pre-wrap">{t.text}</p>
            {t.error && <p className="text-red-700">{t.error}</p>}
            {t.footer && <p className="mt-1 text-xs text-slate-500">{t.footer}</p>}
          </li>
        ))}
      </ol>

      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="Tin nhắn"
          className="min-h-16 flex-1 rounded border border-slate-300 px-2 py-1"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Nhập câu hỏi…"
        />
        {busy ? (
          <button
            type="button"
            className="rounded border border-red-300 px-3 py-1 text-red-800"
            onClick={() => controller.current?.abort()}
          >
            Dừng
          </button>
        ) : (
          <button type="submit" className="rounded bg-sky-800 px-3 py-1 text-white">
            Gửi
          </button>
        )}
      </form>
    </section>
  );
}
