import {
  DEPARTMENT_TYPES,
  DEPARTMENT_TYPE_LABELS_VI,
  type Department,
  type DepartmentType,
} from '@uniai/shared';
import { useEffect, useState } from 'react';
import {
  createDepartment,
  downloadExport,
  fetchDepartments,
  importCsv,
  updateDepartment,
} from '../lib/api';
import { ImportPanel } from './ImportPanel';

export interface DepartmentsApi {
  fetchDepartments: typeof fetchDepartments;
  createDepartment: typeof createDepartment;
  updateDepartment: typeof updateDepartment;
  importCsv: typeof importCsv;
  downloadExport: typeof downloadExport;
}

const defaultApi: DepartmentsApi = {
  fetchDepartments,
  createDepartment,
  updateDepartment,
  importCsv,
  downloadExport,
};
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface Props {
  canEdit: boolean;
  canExport: boolean;
  getToken: () => Promise<string>;
  api?: DepartmentsApi;
}

export function DepartmentsPage({ canEdit, canExport, getToken, api = defaultApi }: Props) {
  const [departments, setDepartments] = useState<Department[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [showImport, setShowImport] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((t) => api.fetchDepartments(t))
      .then((list) => active && (setDepartments(list), setError(null)))
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [api, getToken, reload]);

  async function act(fn: (token: string) => Promise<unknown>) {
    setError(null);
    try {
      await fn(await getToken());
      setEditing(null);
      setReload((r) => r + 1);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const list = departments ?? [];
  const parentOptions = (self?: Department) =>
    list.filter((d) => d.status === 'active' && (!self || !d.path.includes(self.id)));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">Cây đơn vị</h2>
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
          {canExport && (
            <button
              type="button"
              className="rounded border border-slate-300 px-3 py-1"
              onClick={() => void act((t) => api.downloadExport(t, 'departments', 'don-vi.csv'))}
            >
              Xuất CSV
            </button>
          )}
        </div>
      </div>

      {showImport && (
        <ImportPanel
          title="Nhập cây đơn vị"
          templateHref="/templates/don-vi-mau.csv"
          submit={async (csv, dryRun) =>
            api.importCsv(await getToken(), 'departments', csv, dryRun)
          }
          onApplied={() => setReload((r) => r + 1)}
        />
      )}
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {departments === null && !error && <p>Đang tải…</p>}
      {departments?.length === 0 && (
        <p>Chưa có đơn vị nào. Hãy tạo đơn vị gốc (Trường) hoặc nhập CSV.</p>
      )}

      <ul className="flex flex-col text-sm">
        {list.map((d) =>
          editing === d.id ? (
            <li key={d.id}>
              <DepartmentForm
                initial={d}
                parents={parentOptions(d)}
                onCancel={() => setEditing(null)}
                onSubmit={(v) =>
                  act((t) =>
                    api.updateDepartment(t, d.id, {
                      name: v.name,
                      type: v.type,
                      ...(d.parentId ? { parentId: v.parentId } : {}),
                    }),
                  )
                }
              />
            </li>
          ) : (
            <li
              key={d.id}
              className={`flex items-center gap-2 border-b py-1 ${d.status === 'archived' ? 'text-slate-400' : ''}`}
              style={{ paddingLeft: `${(d.path.length - 1) * 1.25}rem` }}
            >
              <span className="font-mono text-xs text-slate-500">{d.id}</span>
              <span>{d.name}</span>
              <span className="text-xs text-slate-500">({DEPARTMENT_TYPE_LABELS_VI[d.type]})</span>
              {d.status === 'archived' && <span className="text-xs">– ngừng sử dụng</span>}
              {canEdit && (
                <span className="ml-auto flex gap-1">
                  <button
                    type="button"
                    aria-label={`Sửa ${d.id}`}
                    className="rounded border border-slate-300 px-2"
                    onClick={() => setEditing(d.id)}
                  >
                    Sửa
                  </button>
                  {d.parentId && (
                    <button
                      type="button"
                      aria-label={`${d.status === 'active' ? 'Ngừng' : 'Dùng lại'} ${d.id}`}
                      className="rounded border border-slate-300 px-2"
                      onClick={() =>
                        void act((t) =>
                          api.updateDepartment(t, d.id, {
                            status: d.status === 'active' ? 'archived' : 'active',
                          }),
                        )
                      }
                    >
                      {d.status === 'active' ? 'Ngừng sử dụng' : 'Dùng lại'}
                    </button>
                  )}
                </span>
              )}
            </li>
          ),
        )}
      </ul>

      {canEdit && departments && (
        <details className="rounded border border-slate-200 p-3 text-sm">
          <summary className="cursor-pointer font-medium">Thêm đơn vị</summary>
          <DepartmentForm
            withCode
            parents={parentOptions()}
            rootAllowed={list.length === 0}
            onSubmit={(v) =>
              act((t) =>
                api.createDepartment(t, {
                  id: v.id,
                  name: v.name,
                  type: v.type,
                  parentId: v.parentId,
                }),
              )
            }
          />
        </details>
      )}
    </section>
  );
}

interface FormValue {
  id: string;
  name: string;
  type: DepartmentType;
  parentId: string | null;
}

function DepartmentForm(props: {
  initial?: Department;
  withCode?: boolean;
  parents: Department[];
  rootAllowed?: boolean;
  onSubmit: (v: FormValue) => Promise<void> | void;
  onCancel?: () => void;
}) {
  const i = props.initial;
  const [id, setId] = useState(i?.id ?? '');
  const [name, setName] = useState(i?.name ?? '');
  const [type, setType] = useState<DepartmentType>(
    i?.type ?? (props.rootAllowed ? 'university' : 'faculty'),
  );
  const [parentId, setParentId] = useState(i?.parentId ?? props.parents[0]?.id ?? '');
  const field = 'rounded border border-slate-300 px-2 py-1';
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void props.onSubmit({ id, name, type, parentId: parentId || null });
      }}
    >
      {props.withCode && (
        <input
          aria-label="Mã đơn vị"
          placeholder="Mã (VD: KTQT)"
          className={`${field} w-32`}
          value={id}
          onChange={(e) => setId(e.target.value)}
          required
        />
      )}
      <input
        aria-label="Tên đơn vị"
        placeholder="Tên đơn vị"
        className={`${field} min-w-56 flex-1`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <select
        aria-label="Loại đơn vị"
        className={field}
        value={type}
        onChange={(e) => setType(e.target.value as DepartmentType)}
      >
        {DEPARTMENT_TYPES.map((t) => (
          <option key={t} value={t}>
            {DEPARTMENT_TYPE_LABELS_VI[t]}
          </option>
        ))}
      </select>
      {(!i || i.parentId) && (
        <select
          aria-label="Đơn vị cha"
          className={field}
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
        >
          {props.rootAllowed && <option value="">(Đơn vị gốc)</option>}
          {props.parents.map((d) => (
            <option key={d.id} value={d.id}>
              {'— '.repeat(d.path.length - 1)}
              {d.name}
            </option>
          ))}
        </select>
      )}
      <button type="submit" className="rounded bg-sky-800 px-3 py-1 text-white">
        {i ? 'Lưu' : 'Thêm'}
      </button>
      {props.onCancel && (
        <button
          type="button"
          className="rounded border border-slate-300 px-3 py-1"
          onClick={props.onCancel}
        >
          Hủy
        </button>
      )}
    </form>
  );
}
