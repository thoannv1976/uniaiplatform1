import {
  FILE_KIND_LABELS_VI,
  formatBytes,
  MAX_PROJECT_FILES,
  PROMPT_CATEGORIES,
  PROMPT_CATEGORY_LABELS_VI,
  type Department,
  type FileView,
  type Project,
  type Prompt,
  type PromptCategory,
  type Role,
} from '@uniai/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  createProject,
  createPrompt,
  deleteFile,
  deleteProject,
  deletePrompt,
  fetchDepartments,
  fetchMyFiles,
  fetchProjects,
  fetchPrompts,
  updateProject,
  updatePrompt,
} from '../lib/api';

export interface WorkspaceApi {
  fetchPrompts: typeof fetchPrompts;
  createPrompt: typeof createPrompt;
  updatePrompt: typeof updatePrompt;
  deletePrompt: typeof deletePrompt;
  fetchProjects: typeof fetchProjects;
  createProject: typeof createProject;
  updateProject: typeof updateProject;
  deleteProject: typeof deleteProject;
  fetchMyFiles: typeof fetchMyFiles;
  deleteFile: typeof deleteFile;
  fetchDepartments: typeof fetchDepartments;
}
const defaultApi: WorkspaceApi = {
  fetchPrompts,
  createPrompt,
  updatePrompt,
  deletePrompt,
  fetchProjects,
  createProject,
  updateProject,
  deleteProject,
  fetchMyFiles,
  deleteFile,
  fetchDepartments,
};
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const field = 'rounded border border-slate-300 px-2 py-1';
const button = 'rounded border border-slate-300 px-3 py-1 text-sm';
const PUBLISHERS: Role[] = ['super_admin', 'ai_admin', 'unit_admin'];
type Tab = 'prompts' | 'projects' | 'files';

interface PromptDraft {
  id: string | null;
  title: string;
  description: string;
  body: string;
  category: PromptCategory;
  shared: boolean;
  publishedTo: string[];
}
const emptyPrompt: PromptDraft = {
  id: null,
  title: '',
  description: '',
  body: '',
  category: 'khac',
  shared: false,
  publishedTo: [],
};

/** Personal workspace (spec 8.10): My Prompts, Projects, My Files. */
export function WorkspacePage({
  role,
  getToken,
  api = defaultApi,
}: {
  role: Role;
  getToken: () => Promise<string>;
  api?: WorkspaceApi;
}) {
  const [tab, setTab] = useState<Tab>('prompts');
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [files, setFiles] = useState<FileView[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState<PromptDraft>(emptyPrompt);
  const [project, setProject] = useState<{
    id: string | null;
    name: string;
    instructions: string;
    fileIds: string[];
  }>({
    id: null,
    name: '',
    instructions: '',
    fileIds: [],
  });
  const canPublish = PUBLISHERS.includes(role);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((t) =>
        Promise.all([
          api.fetchPrompts(t),
          api.fetchProjects(t),
          api.fetchMyFiles(t),
          canPublish ? api.fetchDepartments(t).catch(() => []) : Promise.resolve([]),
        ]),
      )
      .then(([p, pr, f, d]) => {
        if (!active) return;
        setPrompts(p);
        setProjects(pr);
        setFiles(f);
        setDepartments(d.filter((x) => x.status === 'active'));
      })
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, getToken, reload, canPublish]);

  async function act(fn: (t: string) => Promise<unknown>) {
    setError(null);
    try {
      await fn(await getToken());
      setReload((n) => n + 1);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  }

  function savePrompt(e: FormEvent) {
    e.preventDefault();
    const input = {
      title: draft.title,
      description: draft.description,
      body: draft.body,
      category: draft.category,
      visibility: draft.shared ? ('shared' as const) : ('private' as const),
      publishedTo: draft.shared ? draft.publishedTo : [],
    };
    void act((t) =>
      draft.id ? api.updatePrompt(t, draft.id, input) : api.createPrompt(t, input),
    ).then((ok) => ok && setDraft(emptyPrompt));
  }

  function saveProject(e: FormEvent) {
    e.preventDefault();
    const input = {
      name: project.name,
      instructions: project.instructions,
      fileIds: project.fileIds,
    };
    void act((t) =>
      project.id ? api.updateProject(t, project.id, input) : api.createProject(t, input),
    ).then((ok) => ok && setProject({ id: null, name: '', instructions: '', fileIds: [] }));
  }

  const tabButton = (t: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === t}
      className={`rounded px-3 py-1 text-sm ${tab === t ? 'bg-sky-800 text-white' : 'border border-slate-300'}`}
      onClick={() => setTab(t)}
    >
      {label}
    </button>
  );

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-xl font-semibold">Không gian làm việc</h2>
      <div className="flex gap-2" role="tablist">
        {tabButton('prompts', `Prompt (${prompts.length})`)}
        {tabButton('projects', `Dự án (${projects.length})`)}
        {tabButton('files', `Tệp của tôi (${files.length})`)}
      </div>
      {error && (
        <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">
          {error}
        </p>
      )}

      {tab === 'prompts' && (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col gap-2 text-sm">
            {prompts.map((p) => (
              <li key={p.id} className="rounded border border-slate-200 p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{p.title}</span>
                  <span className="text-xs text-slate-500">
                    {PROMPT_CATEGORY_LABELS_VI[p.category]} ·{' '}
                    {p.visibility === 'shared' ? 'Dùng chung' : 'Riêng tôi'}
                    {p.variables.length ? ` · biến: ${p.variables.join(', ')}` : ''}
                  </span>
                  {p.editable && (
                    <>
                      <button
                        type="button"
                        className="ml-auto text-sky-800 underline"
                        onClick={() =>
                          setDraft({
                            id: p.id,
                            title: p.title,
                            description: p.description,
                            body: p.body,
                            category: p.category,
                            shared: p.visibility === 'shared',
                            publishedTo: p.publishedTo,
                          })
                        }
                      >
                        Sửa
                      </button>
                      <button
                        type="button"
                        className="text-red-700 underline"
                        aria-label={`Xóa prompt ${p.title}`}
                        onClick={() => void act((t) => api.deletePrompt(t, p.id))}
                      >
                        Xóa
                      </button>
                    </>
                  )}
                </div>
                {p.description && <p className="text-slate-600">{p.description}</p>}
              </li>
            ))}
            {prompts.length === 0 && <li className="text-slate-500">Chưa có prompt.</li>}
          </ul>
          <form
            className="flex flex-col gap-2 border-t border-slate-200 pt-3 text-sm"
            onSubmit={savePrompt}
          >
            <h3 className="font-semibold">{draft.id ? 'Sửa prompt' : 'Prompt mới'}</h3>
            <label className="flex flex-col">
              Tiêu đề
              <input
                className={field}
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <label className="flex flex-col">
              Mô tả
              <input
                className={field}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
            <label className="flex flex-col">
              Nhóm
              <select
                className={field}
                value={draft.category}
                onChange={(e) => setDraft({ ...draft, category: e.target.value as PromptCategory })}
              >
                {PROMPT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {PROMPT_CATEGORY_LABELS_VI[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col">
              Nội dung (biến viết dạng {'{{tên biến}}'})
              <textarea
                className={`${field} h-28`}
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              />
            </label>
            {canPublish && (
              <fieldset className="flex flex-col gap-1">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.shared}
                    onChange={(e) => setDraft({ ...draft, shared: e.target.checked })}
                  />
                  Chia sẻ cho đơn vị (dùng chung)
                </label>
                {draft.shared && (
                  <select
                    multiple
                    aria-label="Đơn vị nhận"
                    className={`${field} h-28`}
                    value={draft.publishedTo}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        publishedTo: [...e.target.selectedOptions].map((o) => o.value),
                      })
                    }
                  >
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                )}
                {draft.shared && (
                  <span className="text-xs text-slate-500">
                    Không chọn đơn vị nào = toàn trường (chỉ AI Admin, Super Admin).
                  </span>
                )}
              </fieldset>
            )}
            <div className="flex gap-2">
              <button
                type="submit"
                className={button}
                disabled={!draft.title.trim() || !draft.body.trim()}
              >
                Lưu prompt
              </button>
              {draft.id && (
                <button type="button" className={button} onClick={() => setDraft(emptyPrompt)}>
                  Hủy
                </button>
              )}
            </div>
          </form>
        </div>
      )}

      {tab === 'projects' && (
        <div className="flex flex-col gap-3 text-sm">
          <ul className="flex flex-col gap-2">
            {projects.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-2 rounded border border-slate-200 p-2"
              >
                <span className="font-medium">{p.name}</span>
                <span className="text-xs text-slate-500">{p.fileIds.length} tệp</span>
                <Link to={`/?du-an=${p.id}`} className="ml-auto text-sky-800 underline">
                  Chat trong dự án
                </Link>
                <button
                  type="button"
                  className="text-sky-800 underline"
                  onClick={() =>
                    setProject({
                      id: p.id,
                      name: p.name,
                      instructions: p.instructions,
                      fileIds: p.fileIds,
                    })
                  }
                >
                  Sửa
                </button>
                <button
                  type="button"
                  className="text-red-700 underline"
                  aria-label={`Xóa dự án ${p.name}`}
                  onClick={() => void act((t) => api.deleteProject(t, p.id))}
                >
                  Xóa
                </button>
              </li>
            ))}
            {projects.length === 0 && <li className="text-slate-500">Chưa có dự án.</li>}
          </ul>
          <form
            className="flex flex-col gap-2 border-t border-slate-200 pt-3"
            onSubmit={saveProject}
          >
            <h3 className="font-semibold">{project.id ? 'Sửa dự án' : 'Dự án mới'}</h3>
            <label className="flex flex-col">
              Tên dự án
              <input
                className={field}
                value={project.name}
                onChange={(e) => setProject({ ...project, name: e.target.value })}
              />
            </label>
            <label className="flex flex-col">
              Chỉ dẫn cho AI (áp dụng mọi hội thoại trong dự án)
              <textarea
                className={`${field} h-24`}
                value={project.instructions}
                onChange={(e) => setProject({ ...project, instructions: e.target.value })}
              />
            </label>
            <fieldset>
              <legend>Tệp của dự án (tối đa {MAX_PROJECT_FILES})</legend>
              {files.map((f) => (
                <label key={f.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={project.fileIds.includes(f.id)}
                    onChange={() =>
                      setProject({
                        ...project,
                        fileIds: project.fileIds.includes(f.id)
                          ? project.fileIds.filter((x) => x !== f.id)
                          : [...project.fileIds, f.id].slice(0, MAX_PROJECT_FILES),
                      })
                    }
                  />
                  {f.name}
                </label>
              ))}
              {files.length === 0 && (
                <p className="text-slate-500">
                  Chưa có tệp – đính kèm tệp trong chat để dùng lại ở đây.
                </p>
              )}
            </fieldset>
            <button
              type="submit"
              className={`${button} self-start`}
              disabled={!project.name.trim()}
            >
              Lưu dự án
            </button>
          </form>
        </div>
      )}

      {tab === 'files' && (
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500">
            <tr>
              <th className="p-1">Tệp</th>
              <th className="p-1">Loại</th>
              <th className="p-1">Dung lượng</th>
              <th className="p-1">Ngày tải</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id} className="border-t border-slate-100">
                <td className="p-1">{f.name}</td>
                <td className="p-1">{FILE_KIND_LABELS_VI[f.kind]}</td>
                <td className="p-1">
                  {formatBytes(f.size)}
                  {f.pages ? ` · ${f.pages} trang` : ''}
                </td>
                <td className="p-1">{new Date(f.createdAt).toLocaleDateString('vi-VN')}</td>
                <td className="p-1">
                  <button
                    type="button"
                    className="text-red-700 underline"
                    aria-label={`Xóa tệp ${f.name}`}
                    onClick={() => void act((t) => api.deleteFile(t, f.id))}
                  >
                    Xóa
                  </button>
                </td>
              </tr>
            ))}
            {files.length === 0 && (
              <tr>
                <td className="p-1 text-slate-500" colSpan={5}>
                  Chưa có tệp. Tệp đính kèm trong chat được lưu ở đây (tự xóa sau 180 ngày).
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}
