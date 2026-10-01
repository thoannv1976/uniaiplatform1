import type { Role } from '@uniai/shared';
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { AccountPanel } from './components/AccountPanel';
import { ApiStatus } from './components/ApiStatus';
import { AdminUsersPage } from './pages/AdminUsersPage';

const USER_ADMIN_ROLES: Role[] = ['super_admin', 'auditor', 'unit_admin'];
export const ADMIN_USERS_PATH = '/quan-tri/nguoi-dung';

function Home() {
  const { user, profile, signIn, signOut } = useAuth();
  const canSeeAdmin =
    profile.kind === 'ok' &&
    profile.profile.status === 'active' &&
    USER_ADMIN_ROLES.includes(profile.profile.role);
  return (
    <>
      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <AccountPanel
          signedIn={user === undefined ? undefined : user !== null}
          profile={profile}
          onSignIn={signIn}
          onSignOut={signOut}
        />
        {canSeeAdmin && (
          <Link to={ADMIN_USERS_PATH} className="mt-3 inline-block text-sm text-sky-800 underline">
            Quản trị người dùng
          </Link>
        )}
      </section>
      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
        <ApiStatus />
      </section>
    </>
  );
}

function AdminUsers() {
  const { profile, getToken } = useAuth();
  if (profile.kind === 'loading') return <p>Đang tải…</p>;
  if (
    profile.kind !== 'ok' ||
    profile.profile.status !== 'active' ||
    !USER_ADMIN_ROLES.includes(profile.profile.role)
  ) {
    return <Navigate to="/" replace />;
  }
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <Link to="/" className="text-sm text-sky-800 underline">
        ← Trang chủ
      </Link>
      <div className="mt-3">
        <AdminUsersPage
          canEdit={profile.profile.role === 'super_admin'}
          selfUid={profile.profile.uid}
          getToken={getToken}
        />
      </div>
    </section>
  );
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <main className="mx-auto flex min-h-screen max-w-4xl flex-col justify-center gap-6 px-4 py-8">
          <header>
            <p className="text-sm font-semibold tracking-wide text-sky-700">
              TRƯỜNG ĐẠI HỌC NGOẠI THƯƠNG
            </p>
            <h1 className="text-3xl font-bold text-slate-900">University AI Platform</h1>
            <p className="mt-2 text-slate-600">
              Nền tảng AI đa mô hình dùng chung cho cán bộ, giảng viên.
            </p>
          </header>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path={ADMIN_USERS_PATH} element={<AdminUsers />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <footer className="text-xs text-slate-400">Bản phát triển – milestone M2</footer>
        </main>
      </BrowserRouter>
    </AuthProvider>
  );
}
