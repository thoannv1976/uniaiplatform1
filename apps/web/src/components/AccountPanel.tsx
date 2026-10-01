import type { MeResponse } from '@uniai/shared';
import { useEffect, useState } from 'react';
import { fetchMe } from '../lib/api';
import { EMAIL_DOMAIN } from '../lib/config';

export interface AccountUser {
  email: string | null;
  getIdToken: () => Promise<string>;
}

interface Props {
  user: AccountUser | null | undefined;
  onSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
  loadMe?: typeof fetchMe;
}

type MeResult = { kind: 'ok'; me: MeResponse } | { kind: 'error'; message: string };

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function AccountPanel({ user, onSignIn, onSignOut, loadMe = fetchMe }: Props) {
  // The result is tagged with the user it belongs to; a different user means "loading".
  const [result, setResult] = useState<{ user: AccountUser; value: MeResult } | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    user
      .getIdToken()
      .then((token) => loadMe(token, controller.signal))
      .then((data) => setResult({ user, value: { kind: 'ok', me: data } }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setResult({ user, value: { kind: 'error', message: errorMessage(err) } });
      });
    return () => controller.abort();
  }, [user, loadMe]);

  const me: MeResult | { kind: 'loading' } =
    user && result?.user === user ? result.value : { kind: 'loading' };

  if (user === undefined) return <p>Đang kiểm tra phiên đăng nhập…</p>;

  if (user === null) {
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
      {me.kind === 'loading' && <p>Đang xác thực với máy chủ…</p>}
      {me.kind === 'ok' && (
        <p>
          Xin chào <strong>{me.me.name ?? me.me.email}</strong> ({me.me.email})
        </p>
      )}
      {me.kind === 'error' && (
        <p role="alert" className="text-red-700">
          {me.message}
        </p>
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
