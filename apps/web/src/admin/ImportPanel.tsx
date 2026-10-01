import type { ImportResult } from '@uniai/shared';
import { useState } from 'react';

interface Props {
  title: string;
  templateHref: string;
  /** Sends the CSV to the API; dryRun=true only validates. */
  submit: (csv: string, dryRun: boolean) => Promise<ImportResult>;
  onApplied: () => void;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Upload a CSV, preview the result with per-line issues, then apply (all-or-nothing). */
export function ImportPanel({ title, templateHref, submit, onApplied }: Props) {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function run(dryRun: boolean, text = csv) {
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submit(text, dryRun);
      if (dryRun) setPreview(result);
      else if (result.applied) {
        setDone(`Đã áp dụng: thêm ${result.created}, cập nhật ${result.updated}.`);
        setPreview(null);
        setCsv(null);
        setFileName('');
        onApplied();
      } else setPreview(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <strong className="text-sm">{title}</strong>
        <a href={templateHref} download className="text-sm text-sky-800 underline">
          Tải tệp mẫu
        </a>
      </div>
      <label className="text-sm">
        Chọn tệp CSV (Excel: Lưu thành → <em>CSV UTF-8</em>):{' '}
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="Tệp CSV"
          onChange={(e) => {
            const file = e.target.files?.[0];
            setDone(null);
            setPreview(null);
            if (!file) return;
            setFileName(file.name);
            void file.text().then((text) => {
              setCsv(text);
              return run(true, text);
            });
          }}
        />
      </label>
      {busy && <p className="text-sm">Đang xử lý…</p>}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="text-sm text-green-700">
          {done}
        </p>
      )}
      {preview && (
        <div className="flex flex-col gap-2 text-sm">
          <p>
            {fileName}: {preview.total} dòng – thêm mới {preview.created}, cập nhật{' '}
            {preview.updated}, không đổi {preview.unchanged}, lỗi{' '}
            {new Set(preview.issues.map((i) => i.line)).size}.
          </p>
          {preview.issues.length > 0 ? (
            <>
              <p role="alert" className="text-red-700">
                Tệp có lỗi nên chưa ghi gì. Sửa các dòng dưới đây rồi chọn lại tệp.
              </p>
              <table className="w-full text-left">
                <thead className="text-slate-500">
                  <tr>
                    <th className="pr-3">Dòng</th>
                    <th className="pr-3">Cột</th>
                    <th>Lỗi</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.issues.map((i, n) => (
                    <tr key={n}>
                      <td className="pr-3">{i.line}</td>
                      <td className="pr-3">{i.column ?? '—'}</td>
                      <td>{i.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <button
              type="button"
              disabled={busy || preview.created + preview.updated === 0}
              onClick={() => void run(false)}
              className="self-start rounded bg-sky-800 px-3 py-1 text-white disabled:opacity-50"
            >
              Áp dụng {preview.created + preview.updated} thay đổi
            </button>
          )}
        </div>
      )}
    </div>
  );
}
