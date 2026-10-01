import { ApiStatus } from './components/ApiStatus';

export function App() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-4">
      <header>
        <p className="text-sm font-semibold tracking-wide text-sky-700">TRƯỜNG ĐẠI HỌC</p>
        <h1 className="text-3xl font-bold text-slate-900">University AI Platform</h1>
        <p className="mt-2 text-slate-600">
          Nền tảng AI đa mô hình dùng chung cho cán bộ, giảng viên.
        </p>
      </header>
      <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <ApiStatus />
      </section>
      <footer className="text-xs text-slate-400">Bản phát triển – milestone M0</footer>
    </main>
  );
}
