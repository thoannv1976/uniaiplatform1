import { fireEvent, render, screen } from '@testing-library/react';
import type { UserProfile } from '@uniai/shared';
import { describe, expect, it, vi } from 'vitest';
import { AccountPanel } from './AccountPanel';

const noop = () => Promise.resolve();
const profile = (over: Partial<UserProfile> = {}): UserProfile => ({
  uid: 'u1',
  email: 'gv01@ftu.edu.vn',
  name: 'Nguyễn Văn A',
  role: 'user',
  status: 'active',
  departmentId: null,
  scopeDepartmentId: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastLoginAt: null,
  ...over,
});

describe('AccountPanel', () => {
  it('offers Google sign-in when signed out', () => {
    const onSignIn = vi.fn(noop);
    render(
      <AccountPanel
        signedIn={false}
        profile={{ kind: 'loading' }}
        onSignIn={onSignIn}
        onSignOut={noop}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Đăng nhập bằng Google' }));
    expect(onSignIn).toHaveBeenCalledOnce();
    expect(screen.getByText(/@ftu.edu.vn/)).toBeInTheDocument();
  });

  it('shows the profile with role and status labels', () => {
    render(
      <AccountPanel
        signedIn
        profile={{ kind: 'ok', profile: profile({ role: 'super_admin' }) }}
        onSignIn={noop}
        onSignOut={noop}
      />,
    );
    expect(screen.getByText('Nguyễn Văn A')).toBeInTheDocument();
    expect(screen.getByText(/Quản trị hệ thống · Trạng thái: Đang hoạt động/)).toBeInTheDocument();
  });

  it('explains pending and locked accounts', () => {
    const { rerender } = render(
      <AccountPanel
        signedIn
        profile={{ kind: 'ok', profile: profile({ status: 'pending' }) }}
        onSignIn={noop}
        onSignOut={noop}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('chờ quản trị viên duyệt');
    rerender(
      <AccountPanel
        signedIn
        profile={{ kind: 'ok', profile: profile({ status: 'locked' }) }}
        onSignIn={noop}
        onSignOut={noop}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('đã bị khóa');
  });

  it('shows the API refusal for accounts outside the school domain', () => {
    render(
      <AccountPanel
        signedIn
        profile={{
          kind: 'error',
          message: 'Chỉ chấp nhận tài khoản email @ftu.edu.vn đã xác minh.',
        }}
        onSignIn={noop}
        onSignOut={noop}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('@ftu.edu.vn');
  });
});
