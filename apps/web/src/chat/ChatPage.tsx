import {
  CHAT_MODEL_AUTO,
  formatUsd,
  MAX_FILES_PER_MESSAGE,
  MODEL_TIER_LABELS_VI,
  type AttachmentRef,
  type ChatKnowledgeBase,
  type ChatMessage,
  type ChatModelOption,
  type ChatStreamEvent,
  type Conversation,
  type QuotaSummary,
} from '@uniai/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  deleteConversation,
  fetchChatKnowledgeBases,
  fetchChatModels,
  fetchConversation,
  fetchConversations,
  fetchMyQuota,
  streamChat,
  updateConversation,
  uploadFile,
} from '../lib/api';
import { AttachmentChips, AttachmentPicker, type PendingFile } from './Attachments';
import { Citations, KnowledgePicker } from './Knowledge';
import { CopyButton, Markdown } from './Markdown';

export interface ChatApi {
  fetchConversations: typeof fetchConversations;
  fetchConversation: typeof fetchConversation;
  updateConversation: typeof updateConversation;
  deleteConversation: typeof deleteConversation;
  fetchChatModels: typeof fetchChatModels;
  streamChat: typeof streamChat;
  fetchMyQuota: typeof fetchMyQuota;
  uploadFile: typeof uploadFile;
  fetchChatKnowledgeBases: typeof fetchChatKnowledgeBases;
}

const defaultApi: ChatApi = {
  fetchConversations,
  fetchConversation,
  updateConversation,
  deleteConversation,
  fetchChatModels,
  streamChat,
  fetchMyQuota,
  uploadFile,
  fetchChatKnowledgeBases,
};

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
export const CONVERSATION_PATH = '/hoi-thoai';

/** A message as shown: stored messages plus the answer being streamed. */
type ViewMessage = Pick<
  ChatMessage,
  | 'id'
  | 'role'
  | 'content'
  | 'status'
  | 'modelId'
  | 'usage'
  | 'cost'
  | 'error'
  | 'latencyMs'
  | 'attachments'
  | 'citations'
> & { modelName?: string };

const toView = (m: ChatMessage): ViewMessage => ({
  id: m.id,
  role: m.role,
  content: m.content,
  status: m.status,
  modelId: m.modelId,
  usage: m.usage,
  cost: m.cost,
  error: m.error,
  latencyMs: m.latencyMs,
  attachments: m.attachments,
  citations: m.citations,
});

/** Pinned first, then most recently updated; filtered by a case/diacritic-insensitive search. */
export function sortAndFilter(list: Conversation[], query: string): Conversation[] {
  const fold = (s: string) =>
    s.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  const q = fold(query.trim());
  return list
    .filter((c) => !q || fold(c.title).includes(q))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
}

export function ChatPage({
  getToken,
  api = defaultApi,
}: {
  getToken: () => Promise<string>;
  api?: ChatApi;
}) {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [quota, setQuota] = useState<QuotaSummary | null>(null);
  const [model, setModel] = useState<string>(CHAT_MODEL_AUTO);
  /** Messages of the conversation `key` (null = a new conversation not stored yet). */
  const [view, setView] = useState<{ key: string | null; messages: ViewMessage[] }>({
    key: null,
    messages: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [bases, setBases] = useState<ChatKnowledgeBase[]>([]);
  /** Knowledge bases searched, per conversation (null key = new conversation). */
  const [kbSelection, setKbSelection] = useState<{ key: string | null; ids: string[] }>({
    key: null,
    ids: [],
  });
  const uploading = pending.some((p) => p.status === 'uploading');
  const selectedBases = (
    kbSelection.key === (conversationId ?? null) ? kbSelection.ids : []
  ).filter((id) => bases.some((b) => b.id === id));
  const controller = useRef<AbortController | null>(null);
  /** Set when the stream itself created the conversation: its messages are already shown. */
  const skipLoad = useRef<string | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  const currentKey = conversationId ?? null;
  const messages = view.key === currentKey ? view.messages : [];
  const loading = currentKey !== null && view.key !== currentKey && error === null;

  const modelNames = useMemo(() => new Map(models.map((m) => [m.id, m.displayName])), [models]);

  const reloadList = useCallback(async () => {
    try {
      const token = await getToken();
      const [list, q] = await Promise.all([
        api.fetchConversations(token),
        api.fetchMyQuota(token).catch(() => null),
      ]);
      setConversations(list);
      setQuota(q);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [api, getToken]);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((t) =>
        Promise.all([
          api.fetchConversations(t),
          api.fetchChatModels(t),
          api.fetchMyQuota(t).catch(() => null),
          api.fetchChatKnowledgeBases(t).catch(() => []),
        ]),
      )
      .then(([list, options, q, kbs]) => {
        if (!active) return;
        setConversations(list);
        setModels(options);
        setQuota(q);
        setBases(kbs);
      })
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
      controller.current?.abort();
    };
  }, [api, getToken]);

  useEffect(() => {
    if (!conversationId) return;
    if (skipLoad.current === conversationId) {
      skipLoad.current = null;
      return;
    }
    let active = true;
    void getToken()
      .then((t) => api.fetchConversation(t, conversationId))
      .then((detail) => {
        if (!active) return;
        setView({ key: conversationId, messages: detail.messages.map(toView) });
        setKbSelection({ key: conversationId, ids: detail.conversation.knowledgeBaseIds });
      })
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, getToken, conversationId]);

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [view]);

  const updateLast = (fn: (m: ViewMessage) => ViewMessage) =>
    setView((v) => ({
      ...v,
      messages: [...v.messages.slice(0, -1), fn(v.messages.at(-1) as ViewMessage)],
    }));

  function onEvent(e: ChatStreamEvent) {
    if (e.type === 'meta') {
      updateLast((m) => ({
        ...m,
        id: e.messageId,
        modelId: e.model.id,
        modelName: e.model.displayName,
      }));
      if (e.conversationId !== conversationId) {
        skipLoad.current = e.conversationId;
        setView((v) => ({ ...v, key: e.conversationId }));
        setKbSelection((k) =>
          k.key === (conversationId ?? null) ? { ...k, key: e.conversationId } : k,
        );
        void navigate(`${CONVERSATION_PATH}/${e.conversationId}`, { replace: !conversationId });
      }
    } else if (e.type === 'citations') {
      updateLast((m) => ({ ...m, citations: e.citations }));
    } else if (e.type === 'delta') {
      updateLast((m) => ({ ...m, content: m.content + e.text }));
    } else if (e.type === 'error') {
      updateLast((m) => ({ ...m, error: { code: e.code, message: e.message } }));
    } else {
      updateLast((m) => ({
        ...m,
        status: e.status,
        usage: e.usage,
        cost: e.cost,
        latencyMs: e.latencyMs,
      }));
    }
  }

  function addFiles(files: File[]) {
    const room = MAX_FILES_PER_MESSAGE - pending.length;
    if (files.length > room) setError(`Tối đa ${MAX_FILES_PER_MESSAGE} tệp mỗi tin nhắn.`);
    for (const [i, file] of files.slice(0, Math.max(0, room)).entries()) {
      const key = `${Date.now()}-${i}-${file.name}`;
      setPending((list) => [
        ...list,
        { key, name: file.name, size: file.size, status: 'uploading' },
      ]);
      const update = (patch: Partial<PendingFile>) =>
        setPending((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)));
      void getToken()
        .then((t) => api.uploadFile(t, file))
        .then((f) => update({ status: 'ready', file: f }))
        .catch((err: unknown) => update({ status: 'error', error: errorMessage(err) }));
    }
  }

  async function send(text: string, resend?: AttachmentRef[]) {
    const message = text.trim();
    if (!message || busy || (!resend && uploading)) return;
    const attachments =
      resend ??
      pending.flatMap((p) =>
        p.status === 'ready' && p.file
          ? [{ id: p.file.id, name: p.file.name, kind: p.file.kind }]
          : [],
      );
    const chosen = pending;
    if (!resend) setPending([]);
    setError(null);
    setBusy(true);
    setView((v) => {
      const list = v.key === currentKey ? v.messages : [];
      return {
        key: currentKey,
        messages: [
          ...list,
          {
            id: `local-user-${list.length}`,
            role: 'user',
            content: message,
            status: 'complete',
            modelId: null,
            usage: null,
            cost: null,
            error: null,
            latencyMs: null,
            attachments,
            citations: [],
          },
          {
            id: `local-answer-${list.length}`,
            role: 'assistant',
            content: '',
            status: 'streaming',
            modelId: null,
            usage: null,
            cost: null,
            error: null,
            latencyMs: null,
            attachments: [],
            citations: [],
          },
        ],
      };
    });
    let started = false;
    const abort = new AbortController();
    controller.current = abort;
    try {
      await api.streamChat(
        await getToken(),
        {
          message,
          model,
          ...(conversationId ? { conversationId } : {}),
          ...(attachments.length ? { fileIds: attachments.map((a) => a.id) } : {}),
          ...(selectedBases.length ? { knowledgeBaseIds: selectedBases } : {}),
        },
        (e) => {
          if (e.type === 'meta') started = true;
          onEvent(e);
        },
        abort.signal,
      );
    } catch (err) {
      if (abort.signal.aborted) {
        updateLast((m) => ({ ...m, status: 'cancelled' }));
      } else if (started) {
        // The stream had started (the turn is stored): keep it and show the failure.
        updateLast((m) => ({
          ...m,
          status: 'error',
          error: { code: 'network', message: 'Mất kết nối khi đang nhận câu trả lời.' },
        }));
      } else {
        // Nothing was stored (e.g. 403/503 before the stream): take the turn back.
        setView((v) => ({ ...v, messages: v.messages.slice(0, -2) }));
        setInput(message);
        if (!resend) setPending(chosen);
        setError(errorMessage(err));
      }
    } finally {
      controller.current = null;
      setBusy(false);
      void reloadList();
    }
  }

  async function act(fn: (token: string) => Promise<unknown>) {
    setError(null);
    try {
      await fn(await getToken());
      await reloadList();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const visible = sortAndFilter(conversations, search);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');

  return (
    <div className="flex min-h-[70vh] flex-col gap-3 md:flex-row">
      <aside
        className={`${sidebarOpen ? 'flex' : 'hidden'} w-full flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm md:flex md:w-72`}
        aria-label="Danh sách hội thoại"
      >
        <button
          type="button"
          className="rounded bg-sky-800 px-3 py-2 text-sm text-white"
          onClick={() => {
            setSidebarOpen(false);
            void navigate('/');
          }}
        >
          + Hội thoại mới
        </button>
        <input
          type="search"
          aria-label="Tìm hội thoại"
          placeholder="Tìm hội thoại…"
          className="rounded border border-slate-300 px-2 py-1 text-sm"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <ul className="flex flex-col gap-1 overflow-y-auto text-sm">
          {visible.map((c) => (
            <ConversationItem
              key={c.id}
              conversation={c}
              active={c.id === conversationId}
              onOpen={() => {
                setSidebarOpen(false);
                void navigate(`${CONVERSATION_PATH}/${c.id}`);
              }}
              onRename={(title) => void act((t) => api.updateConversation(t, c.id, { title }))}
              onPin={() => void act((t) => api.updateConversation(t, c.id, { pinned: !c.pinned }))}
              onDelete={() =>
                void act(async (t) => {
                  await api.deleteConversation(t, c.id);
                  if (c.id === conversationId) void navigate('/');
                })
              }
            />
          ))}
          {conversations.length > 0 && visible.length === 0 && (
            <li className="text-slate-500">Không tìm thấy hội thoại.</li>
          )}
        </ul>
      </aside>

      <section className="flex flex-1 flex-col gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button
            type="button"
            className="rounded border border-slate-300 px-2 py-1 md:hidden"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            {sidebarOpen ? 'Ẩn hội thoại' : 'Hội thoại'}
          </button>
          <label className="flex items-center gap-2">
            <span>Model</span>
            <select
              aria-label="Chọn model"
              className="rounded border border-slate-300 px-2 py-1"
              value={model}
              disabled={busy}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value={CHAT_MODEL_AUTO}>AUTO – hệ thống tự chọn (khuyên dùng)</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName} ({MODEL_TIER_LABELS_VI[m.tier]})
                </option>
              ))}
            </select>
          </label>
          {quota && <QuotaBadge quota={quota} />}
        </div>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto" aria-live="polite">
          {loading && <p className="text-sm text-slate-500">Đang tải hội thoại…</p>}
          {!loading && messages.length === 0 && (
            <div className="m-auto max-w-md text-center text-sm text-slate-500">
              <p className="text-base font-medium text-slate-700">Bạn cần hỗ trợ gì hôm nay?</p>
              <p>
                Ví dụ: tóm tắt văn bản, soạn email/công văn, đề cương môn học, câu hỏi kiểm tra,
                dịch thuật. Không nhập dữ liệu mật hoặc thông tin cá nhân nhạy cảm.
              </p>
            </div>
          )}
          {messages.map((m, i) => (
            <MessageView
              key={m.id}
              message={m}
              modelName={
                m.modelName ?? (m.modelId ? (modelNames.get(m.modelId) ?? m.modelId) : undefined)
              }
              canRegenerate={
                !busy && i === messages.length - 1 && m.role === 'assistant' && !!lastUser
              }
              onRegenerate={() => lastUser && void send(lastUser.content, lastUser.attachments)}
            />
          ))}
          <div ref={bottom} />
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}

        <KnowledgePicker
          options={bases}
          selected={selectedBases}
          disabled={busy}
          onChange={(ids) => setKbSelection({ key: conversationId ?? null, ids })}
        />
        <AttachmentPicker
          pending={pending}
          disabled={busy}
          onAdd={addFiles}
          onRemove={(key) => setPending((list) => list.filter((p) => p.key !== key))}
        />
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const text = input;
            setInput('');
            void send(text);
          }}
        >
          <textarea
            aria-label="Tin nhắn"
            className="min-h-14 flex-1 resize-y rounded border border-slate-300 px-2 py-1 text-sm"
            placeholder="Nhập câu hỏi… (Enter để gửi, Shift+Enter để xuống dòng)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {busy ? (
            <button
              type="button"
              className="rounded border border-red-300 px-3 py-1 text-sm text-red-800"
              onClick={() => controller.current?.abort()}
            >
              Dừng
            </button>
          ) : (
            <button
              type="submit"
              className="rounded bg-sky-800 px-4 py-1 text-sm text-white disabled:opacity-50"
              disabled={!input.trim() || uploading}
              title={uploading ? 'Đang xử lý tệp đính kèm…' : undefined}
            >
              Gửi
            </button>
          )}
        </form>
      </section>
    </div>
  );
}

function ConversationItem(props: {
  conversation: Conversation;
  active: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onPin: () => void;
  onDelete: () => void;
}) {
  const c = props.conversation;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(c.title);
  if (editing) {
    return (
      <li>
        <form
          className="flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) props.onRename(title.trim());
            setEditing(false);
          }}
        >
          <input
            aria-label="Tên hội thoại"
            className="min-w-0 flex-1 rounded border border-slate-300 px-1"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
          />
          <button type="submit" className="rounded border border-slate-300 px-1 text-xs">
            Lưu
          </button>
        </form>
      </li>
    );
  }
  return (
    <li
      className={`group flex items-center gap-1 rounded px-2 py-1 ${props.active ? 'bg-sky-50 font-medium' : 'hover:bg-slate-50'}`}
    >
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left"
        onClick={props.onOpen}
        title={c.title}
      >
        {c.pinned ? '📌 ' : ''}
        {c.title}
      </button>
      <span className="flex gap-1 text-xs text-slate-500">
        <button type="button" aria-label={`Đổi tên ${c.title}`} onClick={() => setEditing(true)}>
          ✎
        </button>
        <button
          type="button"
          aria-label={`${c.pinned ? 'Bỏ ghim' : 'Ghim'} ${c.title}`}
          onClick={props.onPin}
        >
          {c.pinned ? '⊘' : '⚲'}
        </button>
        <button
          type="button"
          aria-label={`Xóa ${c.title}`}
          onClick={() => {
            if (window.confirm(`Xóa hội thoại "${c.title}"? Không khôi phục được.`))
              props.onDelete();
          }}
        >
          🗑
        </button>
      </span>
    </li>
  );
}

const STATUS_NOTE: Partial<Record<ViewMessage['status'], string>> = {
  cancelled: 'Đã dừng',
  error: 'Lỗi',
};

function MessageView(props: {
  message: ViewMessage;
  modelName?: string;
  canRegenerate: boolean;
  onRegenerate: () => void;
}) {
  const m = props.message;
  if (m.role === 'user') {
    return (
      <div className="ml-auto max-w-[85%] rounded-lg bg-sky-50 px-3 py-2 text-sm whitespace-pre-wrap">
        <AttachmentChips files={m.attachments} />
        {m.content}
      </div>
    );
  }
  const streaming = m.status === 'streaming';
  return (
    <article
      className="max-w-full rounded-lg border border-slate-200 px-3 py-2"
      aria-busy={streaming}
    >
      {m.content ? (
        <Markdown text={m.content} />
      ) : (
        streaming && <p className="text-sm text-slate-500">Đang suy nghĩ…</p>
      )}
      {m.error && <p className="text-sm text-red-700">{m.error.message}</p>}
      <Citations citations={m.citations} />
      <footer className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        {props.modelName && <span>{props.modelName}</span>}
        {m.usage && (
          <span>
            {(m.usage.inputTokens + m.usage.cachedInputTokens).toLocaleString('vi-VN')} token vào ·{' '}
            {m.usage.outputTokens.toLocaleString('vi-VN')} token ra
          </span>
        )}
        {m.cost !== null && <span title={`${m.cost} micro-USD`}>Chi phí {formatUsd(m.cost)}</span>}
        {STATUS_NOTE[m.status] && <span>{STATUS_NOTE[m.status]}</span>}
        {!streaming && m.content && <CopyButton text={m.content} />}
        {props.canRegenerate && (
          <button
            type="button"
            className="rounded border border-slate-300 px-2 text-xs text-slate-600"
            onClick={props.onRegenerate}
          >
            Tạo lại
          </button>
        )}
      </footer>
    </article>
  );
}

/** "Định mức tháng: còn $1.85 / $2.00" – amber from 80 %, red when used up. */
function QuotaBadge({ quota }: { quota: QuotaSummary }) {
  const left = Math.max(0, quota.remaining);
  const color =
    quota.percentUsed >= 100
      ? 'text-red-700'
      : quota.percentUsed >= 80
        ? 'text-amber-700'
        : 'text-slate-500';
  return (
    <span className={`ml-auto text-xs ${color}`} title={`Đã dùng ${quota.percentUsed}%`}>
      Định mức tháng: còn {formatUsd(left)} / {formatUsd(quota.limit)}
    </span>
  );
}
