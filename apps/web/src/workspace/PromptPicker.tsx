import { fillPrompt, PROMPT_CATEGORY_LABELS_VI, type Prompt } from '@uniai/shared';
import { useState } from 'react';

/** Chooses a library prompt, asks for its {{variables}} and inserts the text. */
export function PromptPicker({
  prompts,
  disabled,
  onInsert,
}: {
  prompts: Prompt[];
  disabled: boolean;
  onInsert: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Prompt | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  if (prompts.length === 0) return null;

  function insert(p: Prompt, v: Record<string, string>) {
    onInsert(fillPrompt(p.body, v));
    setOpen(false);
    setChosen(null);
    setValues({});
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="rounded border border-slate-300 px-2 py-1"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        📝 Prompt
      </button>
      {open && (
        <div className="absolute z-10 mt-1 max-h-96 w-80 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
          {!chosen ? (
            <ul aria-label="Thư viện prompt" className="flex flex-col gap-1 text-sm">
              {prompts.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="w-full rounded p-1 text-left hover:bg-slate-50"
                    onClick={() => (p.variables.length ? setChosen(p) : insert(p, {}))}
                  >
                    <span className="font-medium">{p.title}</span>
                    <span className="block text-xs text-slate-500">
                      {PROMPT_CATEGORY_LABELS_VI[p.category]}
                      {p.visibility === 'shared' ? ' · dùng chung' : ' · của tôi'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <form
              className="flex flex-col gap-2 text-sm"
              onSubmit={(e) => {
                e.preventDefault();
                insert(chosen, values);
              }}
            >
              <p className="font-medium">{chosen.title}</p>
              {chosen.variables.map((v) => (
                <label key={v} className="flex flex-col">
                  {v}
                  <input
                    className="rounded border border-slate-300 px-2 py-1"
                    value={values[v] ?? ''}
                    onChange={(e) => setValues({ ...values, [v]: e.target.value })}
                  />
                </label>
              ))}
              <div className="flex gap-2">
                <button type="submit" className="rounded bg-sky-800 px-3 py-1 text-white">
                  Chèn vào ô tin nhắn
                </button>
                <button
                  type="button"
                  className="rounded border border-slate-300 px-3 py-1"
                  onClick={() => setChosen(null)}
                >
                  Quay lại
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
