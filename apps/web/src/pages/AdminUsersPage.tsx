import {
  ROLES,
  ROLE_LABELS_VI,
  USER_STATUS_LABELS_VI,
  type Role,
  type UpdateUserRequest,
  type UserProfile,
  type UserStatus,
} from '@uniai/shared';
import { useCallback, useEffect, useState } from 'react';
import { fetchUsers, updateUser } from '../lib/api';

export interface AdminUsersApi {
  fetchUsers: typeof fetchUsers;
  updateUser: typeof updateUser;
}

interface Props {
  /** Only Super Admins may change users; auditors and unit admins read only. */
  canEdit: boolean;
  /** uid of the signed-in admin (cannot change their own role/status). */
  selfUid: string;
  getToken: () => Promise<string>;
  api?: AdminUsersApi;
}

type Filter = 'pending' | 'all';

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function AdminUsersPage({
  canEdit,
  selfUid,
  getToken,
  api = { fetchUsers, updateUser },
}: Props) {
  const [filter, setFilter] = useState<Filter>('pending');
  const [users, setUsers] = useState<UserProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = await getToken();
    return api.fetchUsers(token, filter === 'pending' ? 'pending' : undefined);
  }, [api, filter, getToken]);

  useEffect(() => {
    let active = true;
    load()
      .then((list) => active && (setUsers(list), setError(null)))
      .catch((err: unknown) => active && setError(errorMessage(err)));
    return () => {
      active = false;
    };
  }, [load]);

  async function change(uid: string, patch: UpdateUserRequest) {
    setBusyUid(uid);
    setError(null);
    try {
      const updated = await api.updateUser(await getToken(), uid, patch);
      setUsers((list) =>
        (list ?? [])
          .map((u) => (u.uid === uid ? updated : u))
          .filter((u) => filter === 'all' || u.status === 'pending'),
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyUid(null);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">Tài khoản đăng nhập</h2>
        <div role="group" aria-label="Lọc" className="flex gap-1 text-sm">
          {(['pending', 'all'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              className={`rounded px-3 py-1 ${filter === f ? 'bg-sky-800 text-white' : 'border border-slate-300'}`}
              onClick={() => {
                setUsers(null);
                setFilter(f);
              }}
            >
              {f === 'pending' ? 'Chờ duyệt' : 'Tất cả'}
            </button>
          ))}
        </div>
      </div>

      {!canEdit && (
        <p className="text-sm text-slate-500">Bạn chỉ có quyền xem danh sách người dùng.</p>
      )}
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {users === null && !error && <p>Đang tải danh sách…</p>}
      {users?.length === 0 && <p>Không có người dùng nào.</p>}

      {users && users.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b text-slate-500">
              <tr>
                <th className="py-2 pr-3">Email</th>
                <th className="py-2 pr-3">Họ tên</th>
                <th className="py-2 pr-3">Vai trò</th>
                <th className="py-2 pr-3">Trạng thái</th>
                {canEdit && <th className="py-2">Thao tác</th>}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const editable = canEdit && u.uid !== selfUid && busyUid !== u.uid;
                return (
                  <tr key={u.uid} className="border-b last:border-0">
                    <td className="py-2 pr-3">{u.email}</td>
                    <td className="py-2 pr-3">{u.name ?? '—'}</td>
                    <td className="py-2 pr-3">
                      {canEdit ? (
                        <select
                          aria-label={`Vai trò của ${u.email}`}
                          value={u.role}
                          disabled={!editable}
                          onChange={(e) => void change(u.uid, { role: e.target.value as Role })}
                          className="rounded border border-slate-300 px-1 py-0.5"
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS_VI[r]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        ROLE_LABELS_VI[u.role]
                      )}
                    </td>
                    <td className="py-2 pr-3">{USER_STATUS_LABELS_VI[u.status]}</td>
                    {canEdit && (
                      <td className="py-2">
                        <StatusActions
                          email={u.email}
                          status={u.status}
                          disabled={!editable}
                          onChange={(status) => void change(u.uid, { status })}
                        />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StatusActions(props: {
  email: string;
  status: UserStatus;
  disabled: boolean;
  onChange: (status: UserStatus) => void;
}) {
  const action =
    props.status === 'pending'
      ? { label: 'Duyệt', to: 'active' as const }
      : props.status === 'active'
        ? { label: 'Khóa', to: 'locked' as const }
        : { label: 'Mở khóa', to: 'active' as const };
  return (
    <button
      type="button"
      aria-label={`${action.label} ${props.email}`}
      disabled={props.disabled}
      onClick={() => props.onChange(action.to)}
      className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50 disabled:opacity-50"
    >
      {action.label}
    </button>
  );
}
