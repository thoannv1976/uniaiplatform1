import type { ChatKnowledgeBase, Citation } from '@uniai/shared';
import { useState } from 'react';

const date = (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : null);

/** Sources under an answer that used the knowledge base (RAG). */
export function Citations({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return null;
  return (
    <details className="mt-2 rounded border border-slate-200 bg-slate-50 p-2 text-xs" open>
      <summary className="cursor-pointer font-medium text-slate-700">
        Nguồn từ kho tri thức ({citations.length})
      </summary>
      <ol className="mt-1 flex flex-col gap-1" aria-label="Nguồn trích dẫn">
        {citations.map((c) => (
          <li key={c.n}>
            <span className="font-medium">
              [{c.n}] {c.title}
            </span>{' '}
            <span className="text-slate-500">
              – phiên bản {c.version}
              {c.effectiveDate ? `, hiệu lực ${date(c.effectiveDate)}` : ''}
              {c.page !== null ? `, trang ${c.page}` : ''}
            </span>
            <p className="line-clamp-2 text-slate-600">{c.snippet}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Which knowledge bases the next questions search. */
export function KnowledgePicker({
  options,
  selected,
  disabled,
  onChange,
}: {
  options: ChatKnowledgeBase[];
  selected: string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  if (options.length === 0) return null;
  const names = options.filter((o) => selected.includes(o.id)).map((o) => o.name);
  return (
    <div className="relative">
      <button
        type="button"
        className={`rounded border px-2 py-1 ${selected.length ? 'border-sky-700 bg-sky-50 text-sky-900' : 'border-slate-300'}`}
        aria-expanded={open}
        disabled={disabled}
        title={names.join(', ') || 'Trả lời dựa trên văn bản chính thức của Trường'}
        onClick={() => setOpen((v) => !v)}
      >
        📚 Kho tri thức{selected.length ? ` (${selected.length})` : ''}
      </button>
      {open && (
        <fieldset className="absolute z-10 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
          <legend className="sr-only">Chọn kho tri thức</legend>
          {options.map((o) => (
            <label key={o.id} className="flex items-start gap-2 p-1 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.includes(o.id)}
                onChange={() =>
                  onChange(
                    selected.includes(o.id)
                      ? selected.filter((id) => id !== o.id)
                      : [...selected, o.id].slice(0, 5),
                  )
                }
              />
              <span>
                {o.name}
                <span className="block text-xs text-slate-500">
                  {o.documentCount} tài liệu{o.description ? ` · ${o.description}` : ''}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}
