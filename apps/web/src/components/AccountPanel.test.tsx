import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { AccountPanel, type AccountUser } from './AccountPanel';

const user: AccountUser = { email: 'gv01@ftu.edu.vn', getIdToken: () => Promise.resolve('tok') };
const noop = () => Promise.resolve();

describe('AccountPanel', () => {
  it('offers Google sign-in when signed out', () => {
    const onSignIn = vi.fn(noop);
    render(<AccountPanel user={null} onSignIn={onSignIn} onSignOut={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Đăng nhập bằng Google' }));
    expect(onSignIn).toHaveBeenCalledOnce();
    expect(screen.getByText(/@ftu.edu.vn/)).toBeInTheDocument();
  });

  it('shows the user returned by the API, using the ID token', async () => {
    const loadMe = vi.fn(() =>
      Promise.resolve({ uid: 'u1', email: 'gv01@ftu.edu.vn', name: 'Nguyễn Văn A' }),
    );
    render(<AccountPanel user={user} onSignIn={noop} onSignOut={noop} loadMe={loadMe} />);
    expect(await screen.findByText('Nguyễn Văn A')).toBeInTheDocument();
    expect(loadMe).toHaveBeenCalledWith('tok', expect.any(AbortSignal));
  });

  it('shows the API refusal for accounts outside the school domain', async () => {
    const loadMe = () =>
      Promise.reject(new ApiError(403, 'Chỉ chấp nhận tài khoản email @ftu.edu.vn đã xác minh.'));
    render(<AccountPanel user={user} onSignIn={noop} onSignOut={noop} loadMe={loadMe} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('@ftu.edu.vn');
  });
});
