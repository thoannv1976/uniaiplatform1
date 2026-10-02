import {
  FILE_ACCEPT,
  formatBytes,
  KB_DOCUMENT_STATUS_LABELS_VI,
  type Department,
  type KbDocument,
  type KnowledgeBase,
} from '@uniai/shared';
import { useEffect, useState, type FormEvent } from 'react';
import {
  createKnowledgeBase,
  deleteKbDocument,
  fetchDepartments,
  fetchKbDocuments,
  fetchKnowledgeBases,
  retryKbDocument,
  updateKnowledgeBase,
  uploadKbDocument,
} from '../lib/api';

export interface KnowledgeApi {
  fetchKnowledgeBases: typeof fetchKnowledgeBases;
  createKnowledgeBase: typeof createKnowledgeBase;
  updateKnowledgeBase: typeof updateKnowledgeBase;
  fetchKbDocuments: typeof fetchKbDocuments;
  uploadKbDocument: typeof uploadKbDocument;
  retryKbDocument: typeof retryKbDocument;
  deleteKbDocument: typeof deleteKbDocument;
  fetchDepartments: typeof fetchDepartments;
}
const defaultApi: KnowledgeApi = {
  fetchKnowledgeBases,
  createKnowledgeBase,
  updateKnowledgeBase,
  fetchKbDocuments,
  uploadKbDocument,
  retryKbDocument,
  deleteKbDocument,
  fetchDepartments,
};
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const field = 'rounded border border-slate-300 px-2 py-1';
const button = 'rounded border border-slate-300 px-3 py-1 text-sm';
const DOC_ACCEPT = FILE_ACCEPT.split(',')
  .filter((t) => !t.startsWith('image/') && !/\.(png|jpe?g|webp|gif)$/.test(t))
  .join(',');
const POLL_MS = 4000;

/** Knowledge Base (spec 8.9): bases, their documents, versions and processing status. */
export function KnowledgePage({
  canEdit,
  getToken,
  api = defaultApi,
}: {
  canEdit: boolean;
  getToken: () => Promise<string>;
  api?: KnowledgeApi;
}) {
  const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [docs, setDocs] = useState<{ kbId: string; list: KbDocument[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [newKb, setNewKb] = useState({ name: '', description: '', aclScopeId: '' });
  const [upload, setUpload] = useState<{
    file: File | null;
    title: string;
    effectiveDate: string;
    replaces: string;
  }>({ file: null, title: '', effectiveDate: '', replaces: '' });

  useEffect(() => {
    let active = true;
    void getToken()
      .then((t) => Promise.all([api.fetchKnowledgeBases(t), api.fetchDepartments(t)]))
      .then(([list, depts]) => {
        if (!active) return;
        setKbs(list);
        setDepartments(depts.filter((d) => d.status === 'active'));
        setSelected((s) => s ?? list[0]?.id ?? null);
      })
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, getToken, reload]);

  const list = docs?.kbId === selected ? docs.list : [];
  const working = list.some((d) => ['uploading', 'queued', 'processing'].includes(d.status));

  useEffect(() => {
    if (!selected) return;
    let active = true;
    const load = () =>
      void getToken()
        .then((t) => api.fetchKbDocuments(t, selected))
        .then((l) => active && setDocs({ kbId: selected, list: l }))
        .catch((err: unknown) => active && setError(errorMessage(err)));
    load();
    const timer = working ? setInterval(load, POLL_MS) : undefined;
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [api, getToken, selected, reload, working]);

  const scopeName = (id: string | null) =>
    id === null ? 'Toàn trường' : (departments.find((d) => d.id === id)?.name ?? id);

  async function act(fn: (t: string) => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await fn(await getToken());
      setReload((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function createKb(e: FormEvent) {
    e.preventDefault();
    void act(async (t) => {
      const kb = await api.createKnowledgeBase(t, {
        name: newKb.name,
        description: newKb.description,
        aclScopeId: newKb.aclScopeId || null,
      });
      setNewKb({ name: '', description: '', aclScopeId: '' });
      setSelected(kb.id);
    });
  }

  function submitUpload(e: FormEvent) {
    e.preventDefault();
    if (!selected || !upload.file) return;
    const file = upload.file;
    void act(async (t) => {
      await api.uploadKbDocument(t, selected, file, {
        title: upload.title || file.name.replace(/\.[^.]+$/, ''),
        effectiveDate: upload.effectiveDate || null,
        replacesDocumentId: upload.replaces || null,
      });
      setUpload({ file: null, title: '', effectiveDate: '', replaces: '' });
    });
  }

  const current = kbs.find((k) => k.id === selected) ?? null;
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">Kho tri thức</h2>
      <p className="text-sm text-slate-600">
        Văn bản chính thức (quy chế, quy định…) để AI trả lời có trích dẫn nguồn. Mỗi kho có phạm
        vi: toàn trường hoặc một đơn vị (gồm đơn vị con).
      </p>
      {error && (
        <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Các kho">
        {kbs.map((k) => (
          <button
            key={k.id}
            type="button"
            role="tab"
            aria-selected={k.id === selected}
            className={`rounded px-3 py-1 text-sm ${k.id === selected ? 'bg-sky-800 text-white' : 'border border-slate-300'}`}
            onClick={() => setSelected(k.id)}
          >
            {k.name} ({k.documentCount}){k.active ? '' : ' – tắt'}
          </button>
        ))}
        {kbs.length === 0 && <p className="text-sm text-slate-500">Chưa có kho tri thức.</p>}
      </div>

      {canEdit && (
        <form className="flex flex-wrap items-end gap-2 text-sm" onSubmit={createKb}>
          <label className="flex flex-col">
            Tên kho mới
            <input
              className={field}
              value={newKb.name}
              onChange={(e) => setNewKb({ ...newKb, name: e.target.value })}
            />
          </label>
          <label className="flex flex-col">
            Mô tả
            <input
              className={field}
              value={newKb.description}
              onChange={(e) => setNewKb({ ...newKb, description: e.target.value })}
            />
          </label>
          <label className="flex flex-col">
            Phạm vi
            <select
              className={field}
              value={newKb.aclScopeId}
              onChange={(e) => setNewKb({ ...newKb, aclScopeId: e.target.value })}
            >
              <option value="">Toàn trường</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={button} disabled={busy || !newKb.name.trim()}>
            Tạo kho
          </button>
        </form>
      )}

      {current && (
        <section className="flex flex-col gap-3 border-t border-slate-200 pt-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-semibold">{current.name}</span>
            <span className="text-slate-600">Phạm vi: {scopeName(current.aclScopeId)}</span>
            {canEdit && (
              <button
                type="button"
                className="text-sky-800 underline"
                onClick={() =>
                  void act((t) =>
                    api.updateKnowledgeBase(t, current.id, { active: !current.active }),
                  )
                }
              >
                {current.active ? 'Tắt kho (không dùng trong chat)' : 'Bật kho'}
              </button>
            )}
          </div>

          {canEdit && (
            <form className="flex flex-wrap items-end gap-2 text-sm" onSubmit={submitUpload}>
              <label className="flex flex-col">
                Tệp (PDF, Word, Excel, PowerPoint, văn bản; ≤ 50 MB)
                <input
                  type="file"
                  accept={DOC_ACCEPT}
                  onChange={(e) => setUpload({ ...upload, file: e.target.files?.[0] ?? null })}
                />
              </label>
              <label className="flex flex-col">
                Tiêu đề
                <input
                  className={field}
                  value={upload.title}
                  onChange={(e) => setUpload({ ...upload, title: e.target.value })}
                />
              </label>
              <label className="flex flex-col">
                Ngày hiệu lực
                <input
                  type="date"
                  className={field}
                  value={upload.effectiveDate}
                  onChange={(e) => setUpload({ ...upload, effectiveDate: e.target.value })}
                />
              </label>
              <label className="flex flex-col">
                Là phiên bản mới của
                <select
                  className={field}
                  value={upload.replaces}
                  onChange={(e) => setUpload({ ...upload, replaces: e.target.value })}
                >
                  <option value="">(tài liệu mới)</option>
                  {list
                    .filter((d) => d.status === 'ready')
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title} (v{d.version})
                      </option>
                    ))}
                </select>
              </label>
              <button type="submit" className={button} disabled={busy || !upload.file}>
                Tải lên
              </button>
            </form>
          )}

          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="p-1">Tài liệu</th>
                <th className="p-1">Phiên bản</th>
                <th className="p-1">Hiệu lực</th>
                <th className="p-1">Trạng thái</th>
                <th className="p-1">Trang / đoạn</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id} className="border-t border-slate-100">
                  <td className="p-1">
                    {d.title}
                    <span className="block text-xs text-slate-500">
                      {d.fileName} · {formatBytes(d.size)}
                    </span>
                  </td>
                  <td className="p-1">v{d.version}</td>
                  <td className="p-1">{d.effectiveDate ?? '—'}</td>
                  <td className="p-1">
                    {KB_DOCUMENT_STATUS_LABELS_VI[d.status]}
                    {d.error && <span className="block text-xs text-red-700">{d.error}</span>}
                  </td>
                  <td className="p-1 tabular-nums">
                    {d.pages ?? '—'} / {d.chunkCount}
                  </td>
                  <td className="flex gap-2 p-1">
                    {canEdit && d.status === 'failed' && (
                      <button
                        type="button"
                        className="text-sky-800 underline"
                        onClick={() => void act((t) => api.retryKbDocument(t, d.id))}
                      >
                        Xử lý lại
                      </button>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        className="text-red-700 underline"
                        aria-label={`Xóa ${d.title} v${d.version}`}
                        onClick={() => {
                          if (window.confirm(`Xóa "${d.title}" v${d.version} khỏi kho?`)) {
                            void act((t) => api.deleteKbDocument(t, d.id));
                          }
                        }}
                      >
                        Xóa
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td className="p-1 text-slate-500" colSpan={6}>
                    Kho chưa có tài liệu.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {working && <p className="text-xs text-slate-500">Đang xử lý… tự cập nhật.</p>}
        </section>
      )}
    </div>
  );
}
