import type { Role } from '@uniai/shared';
import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes } from 'react-router';
import { ChatTestPage } from './admin/ChatTestPage';
import { DepartmentsPage } from './admin/DepartmentsPage';
import { KillSwitchPage } from './admin/KillSwitchPage';
import { KnowledgePage } from './admin/KnowledgePage';
import { RouterPage } from './admin/RouterPage';
import { DirectoryPage } from './admin/DirectoryPage';
import { ModelsPage } from './admin/ModelsPage';
import { ProvidersPage } from './admin/ProvidersPage';
import { QuotaPage } from './admin/QuotaPage';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { AccountPanel } from './components/AccountPanel';
import { ApiStatus } from './components/ApiStatus';
import { TermsGate } from './components/TermsGate';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { DashboardPage } from './usage/DashboardPage';
import { MyUsagePage } from './usage/MyUsagePage';
import { NotificationBell } from './usage/NotificationBell';
import { WorkspacePage } from './workspace/WorkspacePage';
import { ROLE_LABELS_VI, TERMS_VERSION } from '@uniai/shared';

// Markdown, math and code highlighting are only loaded once someone opens the chat.
const ChatPage = lazy(() => import('./chat/ChatPage').then((m) => ({ default: m.ChatPage })));

const PEOPLE_ADMINS: Role[] = ['super_admin', 'auditor', 'unit_admin'];
const DEPARTMENT_VIEWERS: Role[] = ['super_admin', 'auditor', 'unit_admin', 'ai_admin'];
const REGISTRY_VIEWERS: Role[] = ['super_admin', 'ai_admin', 'auditor'];
const REGISTRY_EDITORS: Role[] = ['super_admin', 'ai_admin'];
const QUOTA_VIEWERS: Role[] = ['super_admin', 'unit_admin', 'auditor'];

export const ADMIN_PATHS = {
  directory: '/quan-tri/can-bo',
  accounts: '/quan-tri/tai-khoan',
  departments: '/quan-tri/don-vi',
  models: '/quan-tri/mo-hinh',
  providers: '/quan-tri/nha-cung-cap',
  chatTest: '/quan-tri/thu-chat',
  quotas: '/quan-tri/dinh-muc',
  dashboard: '/quan-tri/thong-ke',
  killSwitch: '/quan-tri/kill-switch',
  router: '/quan-tri/dinh-tuyen',
  knowledge: '/quan-tri/kho-tri-thuc',
} as const;
export const MY_USAGE_PATH = '/muc-su-dung';
export const WORKSPACE_PATH = '/khong-gian';

/** First admin page a role may open. */
function adminHome(role: Role): string {
  if (PEOPLE_ADMINS.includes(role)) return ADMIN_PATHS.directory;
  if (REGISTRY_VIEWERS.includes(role)) return ADMIN_PATHS.models;
  return ADMIN_PATHS.departments;
}

function Home() {
  const { user, profile, signIn, signInWithPassword, signOut, getToken, refreshProfile } =
    useAuth();
  const role =
    profile.kind === 'ok' && profile.profile.status === 'active' ? profile.profile.role : null;
  if (role && profile.kind === 'ok' && profile.profile.termsVersion !== TERMS_VERSION) {
    return (
      <TermsGate getToken={getToken} onAccepted={refreshProfile} onDecline={() => void signOut()} />
    );
  }
  if (role && profile.kind === 'ok') {
    return (
      <>
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
          <span>
            {profile.profile.name ?? profile.profile.email} · {ROLE_LABELS_VI[role]}
          </span>
          <Link to={WORKSPACE_PATH} className="text-sky-800 underline">
            Không gian làm việc
          </Link>
          <Link to={MY_USAGE_PATH} className="text-sky-800 underline">
            Mức sử dụng
          </Link>
          {DEPARTMENT_VIEWERS.includes(role) && (
            <Link to={adminHome(role)} className="text-sky-800 underline">
              Trang quản trị
            </Link>
          )}
          <NotificationBell getToken={getToken} />
          <button type="button" className="text-sky-800 underline" onClick={() => void signOut()}>
            Đăng xuất
          </button>
        </div>
        <Suspense fallback={<p>Đang tải…</p>}>
          <ChatPage getToken={getToken} />
        </Suspense>
      </>
    );
  }
  return (
    <>
      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <AccountPanel
          signedIn={user === undefined ? undefined : user !== null}
          profile={profile}
          onSignIn={signIn}
          onPasswordSignIn={signInWithPassword}
          onSignOut={signOut}
        />
        {role && DEPARTMENT_VIEWERS.includes(role) && (
          <Link to={adminHome(role)} className="mt-3 inline-block text-sm text-sky-800 underline">
            Trang quản trị
          </Link>
        )}
      </section>
      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
        <ApiStatus />
      </section>
    </>
  );
}

/** Renders admin pages only for active users with one of `roles`; others go home. */
function AdminRoute({ roles, children }: { roles: Role[]; children: (role: Role) => ReactNode }) {
  const { profile } = useAuth();
  if (profile.kind === 'loading') return <p>Đang tải…</p>;
  if (
    profile.kind !== 'ok' ||
    profile.profile.status !== 'active' ||
    !roles.includes(profile.profile.role)
  ) {
    return <Navigate to="/" replace />;
  }
  const role = profile.profile.role;
  const tab = 'rounded px-3 py-1';
  const tabClass = ({ isActive }: { isActive: boolean }) =>
    `${tab} ${isActive ? 'bg-sky-800 text-white' : 'border border-slate-300'}`;
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <nav className="flex flex-wrap items-center gap-2 text-sm" aria-label="Quản trị">
        <Link to="/" className="mr-2 text-sky-800 underline">
          ← Trang chủ
        </Link>
        {PEOPLE_ADMINS.includes(role) && (
          <>
            <NavLink to={ADMIN_PATHS.directory} className={tabClass}>
              Cán bộ
            </NavLink>
            <NavLink to={ADMIN_PATHS.accounts} className={tabClass}>
              Tài khoản / Chờ duyệt
            </NavLink>
          </>
        )}
        <NavLink to={ADMIN_PATHS.departments} className={tabClass}>
          Đơn vị
        </NavLink>
        <NavLink to={ADMIN_PATHS.dashboard} className={tabClass}>
          Thống kê
        </NavLink>
        {REGISTRY_VIEWERS.includes(role) && (
          <>
            <NavLink to={ADMIN_PATHS.models} className={tabClass}>
              Model &amp; giá
            </NavLink>
            <NavLink to={ADMIN_PATHS.providers} className={tabClass}>
              Nhà cung cấp AI
            </NavLink>
          </>
        )}
        {QUOTA_VIEWERS.includes(role) && (
          <NavLink to={ADMIN_PATHS.quotas} className={tabClass}>
            Định mức
          </NavLink>
        )}
        {REGISTRY_VIEWERS.includes(role) && (
          <NavLink to={ADMIN_PATHS.knowledge} className={tabClass}>
            Kho tri thức
          </NavLink>
        )}
        {REGISTRY_VIEWERS.includes(role) && (
          <NavLink to={ADMIN_PATHS.router} className={tabClass}>
            Định tuyến
          </NavLink>
        )}
        {REGISTRY_VIEWERS.includes(role) && (
          <NavLink to={ADMIN_PATHS.killSwitch} className={tabClass}>
            Kill switch
          </NavLink>
        )}
        {REGISTRY_EDITORS.includes(role) && (
          <NavLink to={ADMIN_PATHS.chatTest} className={tabClass}>
            Thử chat
          </NavLink>
        )}
      </nav>
      {children(role)}
    </section>
  );
}

function MyUsageRoute() {
  const { profile, getToken } = useAuth();
  if (profile.kind === 'loading') return <p>Đang tải…</p>;
  if (profile.kind !== 'ok' || profile.profile.status !== 'active') {
    return <Navigate to="/" replace />;
  }
  return (
    <>
      <Link to="/" className="text-sm text-sky-800 underline">
        ← Trang chủ
      </Link>
      <MyUsagePage getToken={getToken} />
    </>
  );
}

function WorkspaceRoute() {
  const { profile, getToken } = useAuth();
  if (profile.kind === 'loading') return <p>Đang tải…</p>;
  if (profile.kind !== 'ok' || profile.profile.status !== 'active') {
    return <Navigate to="/" replace />;
  }
  return (
    <>
      <Link to="/" className="text-sm text-sky-800 underline">
        ← Trang chủ
      </Link>
      <WorkspacePage role={profile.profile.role} getToken={getToken} />
    </>
  );
}

function AdminPages() {
  const { profile, getToken } = useAuth();
  const me = profile.kind === 'ok' ? profile.profile : null;
  return (
    <Routes>
      <Route
        path="can-bo"
        element={
          <AdminRoute roles={PEOPLE_ADMINS}>
            {(role) => (
              <DirectoryPage
                role={role}
                selfUid={me?.uid ?? ''}
                scopeDepartmentId={me?.scopeDepartmentId ?? null}
                getToken={getToken}
              />
            )}
          </AdminRoute>
        }
      />
      <Route
        path="tai-khoan"
        element={
          <AdminRoute roles={PEOPLE_ADMINS}>
            {(role) => (
              <AdminUsersPage
                canEdit={role === 'super_admin'}
                selfUid={me?.uid ?? ''}
                getToken={getToken}
              />
            )}
          </AdminRoute>
        }
      />
      <Route
        path="don-vi"
        element={
          <AdminRoute roles={DEPARTMENT_VIEWERS}>
            {(role) => (
              <DepartmentsPage
                canEdit={role === 'super_admin'}
                canExport={role === 'super_admin' || role === 'auditor'}
                getToken={getToken}
              />
            )}
          </AdminRoute>
        }
      />
      <Route
        path="mo-hinh"
        element={
          <AdminRoute roles={REGISTRY_VIEWERS}>
            {(role) => <ModelsPage canEdit={REGISTRY_EDITORS.includes(role)} getToken={getToken} />}
          </AdminRoute>
        }
      />
      <Route
        path="nha-cung-cap"
        element={
          <AdminRoute roles={REGISTRY_VIEWERS}>
            {(role) => (
              <ProvidersPage
                canEdit={REGISTRY_EDITORS.includes(role)}
                canSetKey={role === 'super_admin'}
                getToken={getToken}
              />
            )}
          </AdminRoute>
        }
      />
      <Route
        path="thu-chat"
        element={
          <AdminRoute roles={REGISTRY_EDITORS}>
            {() => <ChatTestPage getToken={getToken} />}
          </AdminRoute>
        }
      />
      <Route
        path="dinh-muc"
        element={
          <AdminRoute roles={QUOTA_VIEWERS}>
            {(role) => (
              <QuotaPage
                canEdit={role === 'super_admin' || role === 'unit_admin'}
                canEditTiers={role === 'super_admin'}
                getToken={getToken}
              />
            )}
          </AdminRoute>
        }
      />
      <Route
        path="kho-tri-thuc"
        element={
          <AdminRoute roles={REGISTRY_VIEWERS}>
            {(role) => (
              <KnowledgePage canEdit={REGISTRY_EDITORS.includes(role)} getToken={getToken} />
            )}
          </AdminRoute>
        }
      />
      <Route
        path="dinh-tuyen"
        element={
          <AdminRoute roles={REGISTRY_VIEWERS}>
            {(role) => <RouterPage canEdit={REGISTRY_EDITORS.includes(role)} getToken={getToken} />}
          </AdminRoute>
        }
      />
      <Route
        path="kill-switch"
        element={
          <AdminRoute roles={REGISTRY_VIEWERS}>
            {(role) => (
              <KillSwitchPage canEdit={REGISTRY_EDITORS.includes(role)} getToken={getToken} />
            )}
          </AdminRoute>
        }
      />
      <Route
        path="thong-ke"
        element={
          <AdminRoute roles={DEPARTMENT_VIEWERS}>
            {(role) => <DashboardPage role={role} getToken={getToken} />}
          </AdminRoute>
        }
      />
      <Route path="nguoi-dung" element={<Navigate to={ADMIN_PATHS.accounts} replace />} />
      <Route path="*" element={<Navigate to={me ? adminHome(me.role) : '/'} replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 px-4 py-6">
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
            <Route path="/hoi-thoai/:conversationId" element={<Home />} />
            <Route path={MY_USAGE_PATH} element={<MyUsageRoute />} />
            <Route path={WORKSPACE_PATH} element={<WorkspaceRoute />} />
            <Route path="/quan-tri/*" element={<AdminPages />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <footer className="text-xs text-slate-400">Phiên bản 1.0 – pilot</footer>
        </main>
      </BrowserRouter>
    </AuthProvider>
  );
}
