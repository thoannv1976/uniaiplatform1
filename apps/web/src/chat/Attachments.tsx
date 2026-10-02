import {
  FILE_ACCEPT,
  FILE_KIND_LABELS_VI,
  formatBytes,
  MAX_FILES_PER_MESSAGE,
  type AttachmentRef,
  type FileView,
} from '@uniai/shared';
import { useRef } from 'react';

/** A file chosen for the next message, while and after it uploads. */
export interface PendingFile {
  key: string;
  name: string;
  size: number;
  status: 'uploading' | 'ready' | 'error';
  file?: FileView;
  error?: string;
}

const KIND_ICON: Record<AttachmentRef['kind'], string> = {
  pdf: '📄',
  docx: '📝',
  xlsx: '📊',
  pptx: '📽',
  text: '🗒',
  image: '🖼',
};

/** Chips for files attached to a sent message. */
export function AttachmentChips({ files }: { files: AttachmentRef[] }) {
  if (files.length === 0) return null;
  return (
    <ul className="mb-1 flex flex-wrap gap-1" aria-label="Tệp đính kèm">
      {files.map((f) => (
        <li
          key={f.id}
          className="rounded border border-sky-200 bg-white px-2 py-0.5 text-xs text-slate-700"
          title={FILE_KIND_LABELS_VI[f.kind]}
        >
          <span aria-hidden>{KIND_ICON[f.kind]} </span>
          {f.name}
        </li>
      ))}
    </ul>
  );
}

/** The paperclip button and the files waiting to be sent with the next message. */
export function AttachmentPicker({
  pending,
  disabled,
  onAdd,
  onRemove,
}: {
  pending: PendingFile[];
  disabled: boolean;
  onAdd: (files: File[]) => void;
  onRemove: (key: string) => void;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const full = pending.length >= MAX_FILES_PER_MESSAGE;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={FILE_ACCEPT}
        aria-label="Chọn tệp đính kèm"
        onChange={(e) => {
          onAdd([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        className="rounded border border-slate-300 px-2 py-1 disabled:opacity-50"
        disabled={disabled || full}
        title={
          full
            ? `Tối đa ${MAX_FILES_PER_MESSAGE} tệp mỗi tin nhắn`
            : 'PDF, Word, Excel, PowerPoint, văn bản, ảnh'
        }
        onClick={() => input.current?.click()}
      >
        📎 Đính kèm
      </button>
      {pending.map((p) => (
        <span
          key={p.key}
          className={`flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${
            p.status === 'error'
              ? 'border-red-300 bg-red-50 text-red-800'
              : 'border-slate-300 bg-slate-50 text-slate-700'
          }`}
        >
          <span>
            {p.name} · {formatBytes(p.size)}
            {p.status === 'uploading' && ' · đang xử lý…'}
            {p.status === 'ready' && p.file?.pages ? ` · ${p.file.pages} trang` : ''}
            {p.status === 'ready' && p.file?.truncated ? ' · đã cắt bớt' : ''}
            {p.status === 'error' && ` · ${p.error}`}
          </span>
          <button
            type="button"
            aria-label={`Bỏ tệp ${p.name}`}
            className="px-1 text-slate-500 hover:text-slate-900"
            onClick={() => onRemove(p.key)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
