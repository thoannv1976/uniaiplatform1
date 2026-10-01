import {
  QUOTA_TIER_IDS,
  QUOTA_TIER_LABELS_VI,
  ROLES,
  ROLE_LABELS_VI,
  USER_STATUS_LABELS_VI,
  type Department,
  type DirectoryEntry,
  type QuotaTierId,
  type Role,
  type UpdateDirectoryRequest,
} from '@uniai/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  downloadExport,
  fetchDepartments,
  fetchDirectory,
  importCsv,
  updateDirectoryEntry,
} from '../lib/api';
import { ImportPanel } from './ImportPanel';

export interface DirectoryApi {
  fetchDirectory: typeof fetchDirectory;
  fetchDepartments: typeof fetchDepartments;
  updateDirectoryEntry: typeof updateDirectoryEntry;
  importCsv: typeof importCsv;
  downloadExport: typeof downloadExport;
}

const defaultApi: DirectoryApi = {
  fetchDirectory,
  fetchDepartments,
  updateDirectoryEntry,
  importCsv,
  downloadExport,
};

interface Props {
  role: Role;
  selfUid: string;
  /** For unit_admin: the department they manage. */
  scopeDepartmentId: string | null;
  getToken: () => Promise<string>;
  api?: DirectoryApi;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

export function DirectoryPage({
  role,
  selfUid,
  scopeDepartmentId,
  getToken,
  api = defaultApi,
}: Props) {
  const canEdit = role === 'super_admin' || role === 'unit_admin';
  const isSuper = role === 'super_admin';
  const [entries, setEntries] = useState<DirectoryEntry[] | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const token = await getToken();
        const [list, depts] = await Promise.all([
          api.fetchDirectory(token),
          api.fetchDepartments(token),
        ]);
        if (!active) return;
        setEntries(list);
        setDepartments(depts);
        setError(null);
      } catch (err) {
        if (active) setError(errorMessage(err));
      }
    })();
    return () => {
      active = false;
    };
  }, [api, getToken, reload]);

  const deptName = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments]);
  /** Departments this admin may assign people to. */
  const assignable = useMemo(
    () =>
      departments.filter(
        (d) =>
          d.status === 'active' &&
          (isSuper || (scopeDepartmentId !== null && d.path.includes(scopeDepartmentId))),
      ),
    [departments, isSuper, scopeDepartmentId],
  );

  const visible = useMemo(() => {
    // Every word must match somewhere, ignoring case and Vietnamese diacritics.
    const words = fold(query).split(/\s+/).filter(Boolean);
    return (entries ?? []).filter((e) => {
      if (deptFilter && !e.departmentPath.includes(deptFilter)) return false;
      const haystack = fold(`${e.email} ${e.fullName ?? ''} ${e.staffCode ?? ''}`);
      return words.every((w) => haystack.includes(w));
    });
  }, [entries, query, deptFilter]);

  const save = useCallback(
    async (email: string, patch: UpdateDirectoryRequest) => {
      setError(null);
      try {
        const updated = await api.updateDirectoryEntry(await getToken(), email, patch);
        setEntries((list) => (list ?? []).map((e) => (e.email === email ? updated : e)));
        setEditing(null);
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [api, getToken],
  );

  const manageable = (e: DirectoryEntry) =>
    canEdit && e.uid !== selfUid && (isSuper || e.role === 'user');

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">Danh bạ cán bộ</h2>
        <div className="flex gap-2 text-sm">
          {canEdit && (
            <button
              type="button"
              className="rounded border border-slate-300 px-3 py-1"
              onClick={() => setShowImport((v) => !v)}
            >
              Nhập CSV
            </button>
          )}
          <button
            type="button"
            className="rounded border border-slate-300 px-3 py-1"
            onClick={() =>
              void getToken()
                .then((t) => api.downloadExport(t, 'directory', 'can-bo.csv'))
                .catch((err: unknown) => setError(errorMessage(err)))
            }
          >
            Xuất CSV
          </button>
        </div>
      </div>

      {showImport && (
        <ImportPanel
          title={
            isSuper
              ? 'Nhập danh sách cán bộ'
              : 'Nhập cán bộ cho đơn vị của bạn (chỉ vai trò "user")'
          }
          templateHref="/templates/can-bo-mau.csv"
          submit={async (csv, dryRun) => api.importCsv(await getToken(), 'directory', csv, dryRun)}
          onApplied={() => setReload((r) => r + 1)}
        />
      )}

      <div className="flex flex-wrap gap-2 text-sm">
        <input
          type="search"
          placeholder="Tìm theo email, họ tên, mã cán bộ"
          aria-label="Tìm kiếm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-64 flex-1 rounded border border-slate-300 px-2 py-1"
        />
        <select
          aria-label="Lọc theo đơn vị"
          value={deptFilter}
          onChange={(e) => setDeptFilter(e.target.value)}
          className="rounded border border-slate-300 px-2 py-1"
        >
          <option value="">Tất cả đơn vị</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {'— '.repeat(d.path.length - 1)}
              {d.name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {entries === null && !error && <p>Đang tải danh bạ…</p>}
      {entries && (
        <p className="text-sm text-slate-500">
          {visible.length} / {entries.length} cán bộ
        </p>
      )}

      {visible.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-slate-500">
              <tr>
                <th className="py-2 pr-3">Email</th>
                <th className="py-2 pr-3">Họ tên</th>
                <th className="py-2 pr-3">Mã CB</th>
                <th className="py-2 pr-3">Đơn vị</th>
                <th className="py-2 pr-3">Chức vụ</th>
                <th className="py-2 pr-3">Vai trò</th>
                <th className="py-2 pr-3">Định mức</th>
                <th className="py-2 pr-3">Trạng thái</th>
                {canEdit && <th className="py-2">Thao tác</th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((e) =>
                editing === e.email ? (
                  <EditRow
                    key={e.email}
                    entry={e}
                    isSuper={isSuper}
                    departments={assignable}
                    allDepartments={departments}
                    onCancel={() => setEditing(null)}
                    onSave={(patch) => void save(e.email, patch)}
                  />
                ) : (
                  <tr key={e.email} className="border-b last:border-0">
                    <td className="py-2 pr-3">{e.email}</td>
                    <td className="py-2 pr-3">{e.fullName ?? '—'}</td>
                    <td className="py-2 pr-3">{e.staffCode ?? '—'}</td>
                    <td className="py-2 pr-3">
                      {e.departmentId ? (deptName.get(e.departmentId) ?? e.departmentId) : '—'}
                    </td>
                    <td className="py-2 pr-3">{e.title ?? '—'}</td>
                    <td className="py-2 pr-3">{ROLE_LABELS_VI[e.role]}</td>
                    <td className="py-2 pr-3">{QUOTA_TIER_LABELS_VI[e.quotaTierId]}</td>
                    <td className="py-2 pr-3">{USER_STATUS_LABELS_VI[e.status]}</td>
                    {canEdit && (
                      <td className="flex gap-1 py-2">
                        {manageable(e) && (
                          <>
                            <button
                              type="button"
                              aria-label={`Sửa ${e.email}`}
                              className="rounded border border-slate-300 px-2"
                              onClick={() => setEditing(e.email)}
                            >
                              Sửa
                            </button>
                            <button
                              type="button"
                              aria-label={`${e.status === 'locked' ? 'Mở khóa' : 'Khóa'} ${e.email}`}
                              className="rounded border border-slate-300 px-2"
                              onClick={() =>
                                void save(e.email, {
                                  status: e.status === 'locked' ? 'active' : 'locked',
                                })
                              }
                            >
                              {e.status === 'locked' ? 'Mở khóa' : 'Khóa'}
                            </button>
                          </>
                        )}
                      </td>
                    )}
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function EditRow(props: {
  entry: DirectoryEntry;
  isSuper: boolean;
  departments: Department[];
  allDepartments: Department[];
  onCancel: () => void;
  onSave: (patch: UpdateDirectoryRequest) => void;
}) {
  const { entry: e } = props;
  const [fullName, setFullName] = useState(e.fullName ?? '');
  const [staffCode, setStaffCode] = useState(e.staffCode ?? '');
  const [title, setTitle] = useState(e.title ?? '');
  const [departmentId, setDepartmentId] = useState(e.departmentId ?? '');
  const [quotaTierId, setQuotaTierId] = useState<QuotaTierId>(e.quotaTierId);
  const [role, setRole] = useState<Role>(e.role);
  const [scope, setScope] = useState(e.scopeDepartmentId ?? '');
  const input = 'w-full rounded border border-slate-300 px-1';

  return (
    <tr className="border-b bg-sky-50">
      <td className="py-2 pr-3">{e.email}</td>
      <td className="py-2 pr-3">
        <input
          aria-label="Họ tên"
          className={input}
          value={fullName}
          onChange={(x) => setFullName(x.target.value)}
        />
      </td>
      <td className="py-2 pr-3">
        <input
          aria-label="Mã cán bộ"
          className={input}
          value={staffCode}
          onChange={(x) => setStaffCode(x.target.value)}
        />
      </td>
      <td className="py-2 pr-3">
        <select
          aria-label="Đơn vị"
          className={input}
          value={departmentId}
          onChange={(x) => setDepartmentId(x.target.value)}
        >
          {props.isSuper && <option value="">(Chưa có)</option>}
          {props.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </td>
      <td className="py-2 pr-3">
        <input
          aria-label="Chức vụ"
          className={input}
          value={title}
          onChange={(x) => setTitle(x.target.value)}
        />
      </td>
      <td className="py-2 pr-3">
        {props.isSuper ? (
          <div className="flex flex-col gap-1">
            <select
              aria-label="Vai trò"
              className={input}
              value={role}
              onChange={(x) => setRole(x.target.value as Role)}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS_VI[r]}
                </option>
              ))}
            </select>
            {role === 'unit_admin' && (
              <select
                aria-label="Đơn vị quản lý"
                className={input}
                value={scope}
                onChange={(x) => setScope(x.target.value)}
              >
                <option value="">(Chọn đơn vị quản lý)</option>
                {props.allDepartments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        ) : (
          ROLE_LABELS_VI[e.role]
        )}
      </td>
      <td className="py-2 pr-3">
        <select
          aria-label="Nhóm định mức"
          className={input}
          value={quotaTierId}
          onChange={(x) => setQuotaTierId(x.target.value as QuotaTierId)}
        >
          {QUOTA_TIER_IDS.map((t) => (
            <option key={t} value={t}>
              {QUOTA_TIER_LABELS_VI[t]}
            </option>
          ))}
        </select>
      </td>
      <td className="py-2 pr-3">{USER_STATUS_LABELS_VI[e.status]}</td>
      <td className="flex gap-1 py-2">
        <button
          type="button"
          className="rounded bg-sky-800 px-2 text-white"
          onClick={() =>
            props.onSave({
              fullName,
              staffCode,
              title,
              departmentId: departmentId || null,
              quotaTierId,
              ...(props.isSuper
                ? { role, scopeDepartmentId: role === 'unit_admin' ? scope || null : null }
                : {}),
            })
          }
        >
          Lưu
        </button>
        <button
          type="button"
          className="rounded border border-slate-300 px-2"
          onClick={props.onCancel}
        >
          Hủy
        </button>
      </td>
    </tr>
  );
}
