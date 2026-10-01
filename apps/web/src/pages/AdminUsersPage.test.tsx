import { fireEvent, render, screen, within } from '@testing-library/react';
import type { UserProfile } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { AdminUsersPage, type AdminUsersApi } from './AdminUsersPage';

const user = (uid: string, over: Partial<UserProfile> = {}): UserProfile => ({
  uid,
  email: `${uid}@ftu.edu.vn`,
  name: null,
  role: 'user',
  status: 'pending',
  departmentId: null,
  scopeDepartmentId: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastLoginAt: null,
  ...over,
});

const getToken = () => Promise.resolve('tok');

function fakeApi(list: UserProfile[]): AdminUsersApi & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    fetchUsers: vi.fn((_token: string, status?: string) =>
      Promise.resolve(status ? list.filter((u) => u.status === status) : list),
    ),
    updateUser: vi.fn((_token: string, uid: string, patch: object) => {
      calls.push({ uid, patch });
      const found = list.find((u) => u.uid === uid) as UserProfile;
      return Promise.resolve({ ...found, ...patch });
    }),
  };
}

describe('AdminUsersPage', () => {
  it('lists pending users and approves one (Super Admin)', async () => {
    const api = fakeApi([user('gv01'), user('gv02', { status: 'active' })]);
    render(<AdminUsersPage canEdit selfUid="sa" getToken={getToken} api={api} />);
    expect(await screen.findByText('gv01@ftu.edu.vn')).toBeInTheDocument();
    expect(screen.queryByText('gv02@ftu.edu.vn')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Duyệt gv01@ftu.edu.vn' }));
    await screen.findByText('Không có người dùng nào.');
    expect(api.calls).toEqual([{ uid: 'gv01', patch: { status: 'active' } }]);
  });

  it('shows all users and lets the Super Admin change a role, but not their own', async () => {
    const api = fakeApi([
      user('sa', { role: 'super_admin', status: 'active' }),
      user('gv02', { status: 'active' }),
    ]);
    render(<AdminUsersPage canEdit selfUid="sa" getToken={getToken} api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tất cả' }));
    const select = await screen.findByLabelText('Vai trò của gv02@ftu.edu.vn');
    fireEvent.change(select, { target: { value: 'auditor' } });
    await vi.waitFor(() =>
      expect(api.calls).toEqual([{ uid: 'gv02', patch: { role: 'auditor' } }]),
    );
    expect(screen.getByLabelText('Vai trò của sa@ftu.edu.vn')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Khóa sa@ftu.edu.vn' })).toBeDisabled();
  });

  it('is read-only for auditors and unit admins', async () => {
    const api = fakeApi([user('gv01')]);
    render(<AdminUsersPage canEdit={false} selfUid="au" getToken={getToken} api={api} />);
    const row = (await screen.findByText('gv01@ftu.edu.vn')).closest('tr') as HTMLElement;
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText('Bạn chỉ có quyền xem danh sách người dùng.')).toBeInTheDocument();
  });

  it('shows API errors in Vietnamese', async () => {
    const api = fakeApi([]);
    api.fetchUsers = () => Promise.reject(new Error('Bạn không có quyền thực hiện thao tác này.'));
    render(<AdminUsersPage canEdit selfUid="sa" getToken={getToken} api={api} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('không có quyền');
  });
});
