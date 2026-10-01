import { ROLE_LABELS_VI, USER_STATUS_LABELS_VI } from '@uniai/shared';
import { useState } from 'react';
import type { ProfileState } from '../auth/AuthProvider';
import { EMAIL_DOMAIN } from '../lib/config';

interface Props {
  /** undefined while the session is restored; null when signed out. */
  signedIn: boolean | undefined;
  profile: ProfileState;
  onSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function AccountPanel({ signedIn, profile, onSignIn, onSignOut }: Props) {
  const [signInError, setSignInError] = useState<string | null>(null);

  if (signedIn === undefined) return <p>Đang kiểm tra phiên đăng nhập…</p>;

  if (!signedIn) {
    return (
      <div className="flex flex-col items-start gap-2">
        <button
          type="button"
          className="rounded-md bg-sky-800 px-4 py-2 font-medium text-white hover:bg-sky-900"
          onClick={() => {
            setSignInError(null);
            onSignIn().catch((err: unknown) => setSignInError(errorMessage(err)));
          }}
        >
          Đăng nhập bằng Google
        </button>
        <p className="text-sm text-slate-500">Dùng tài khoản email @{EMAIL_DOMAIN} của trường.</p>
        {signInError && (
          <p role="alert" className="text-sm text-red-700">
            Đăng nhập không thành công: {signInError}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-2">
      {profile.kind === 'loading' && <p>Đang xác thực với máy chủ…</p>}
      {profile.kind === 'error' && (
        <p role="alert" className="text-red-700">
          {profile.message}
        </p>
      )}
      {profile.kind === 'ok' && (
        <>
          <p>
            Xin chào <strong>{profile.profile.name ?? profile.profile.email}</strong> (
            {profile.profile.email})
          </p>
          <p className="text-sm text-slate-600">
            Vai trò: {ROLE_LABELS_VI[profile.profile.role]} · Trạng thái:{' '}
            {USER_STATUS_LABELS_VI[profile.profile.status]}
          </p>
          {profile.profile.status === 'pending' && (
            <p role="alert" className="rounded bg-amber-50 p-2 text-sm text-amber-900">
              Tài khoản của bạn đang chờ quản trị viên duyệt. Bạn sẽ dùng được hệ thống sau khi được
              duyệt.
            </p>
          )}
          {profile.profile.status === 'locked' && (
            <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800">
              Tài khoản đã bị khóa. Vui lòng liên hệ quản trị viên.
            </p>
          )}
        </>
      )}
      <button
        type="button"
        className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
        onClick={() => void onSignOut()}
      >
        Đăng xuất
      </button>
    </div>
  );
}
