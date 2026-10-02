import { TERMS_SECTIONS_VI, TERMS_TITLE_VI, TERMS_VERSION } from '@uniai/shared';
import { useState } from 'react';
import { acceptTerms } from '../lib/api';

/** First sign-in (and after the terms change): read and accept before using AI (spec 12). */
export function TermsGate({
  getToken,
  onAccepted,
  onDecline,
  accept = acceptTerms,
}: {
  getToken: () => Promise<string>;
  onAccepted: () => void;
  onDecline: () => void;
  accept?: typeof acceptTerms;
}) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await accept(await getToken(), TERMS_VERSION);
      onAccepted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <section
      className="mx-auto flex max-w-2xl flex-col gap-3 rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
      aria-labelledby="terms-title"
    >
      <h2 id="terms-title" className="text-xl font-semibold">
        {TERMS_TITLE_VI}
      </h2>
      <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-700">
        {TERMS_SECTIONS_VI.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ol>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
        />
        <span>Tôi đã đọc và đồng ý với Điều khoản sử dụng.</span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded bg-sky-800 px-4 py-2 text-sm text-white disabled:opacity-50"
          disabled={!checked || busy}
          onClick={() => void submit()}
        >
          Đồng ý và tiếp tục
        </button>
        <button
          type="button"
          className="rounded border border-slate-300 px-4 py-2 text-sm"
          onClick={onDecline}
        >
          Không đồng ý (đăng xuất)
        </button>
      </div>
      <p className="text-xs text-slate-400">Phiên bản {TERMS_VERSION}</p>
    </section>
  );
}
