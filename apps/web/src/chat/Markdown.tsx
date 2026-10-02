import 'highlight.js/styles/github.css';
import 'katex/dist/katex.min.css';
import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

/** Plain text of a rendered node tree (for the copy button of code blocks). */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return '';
}

export function CopyButton({ text, label = 'Sao chép' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded border border-slate-300 bg-white px-2 text-xs text-slate-600 hover:bg-slate-50"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Đã chép' : label}
    </button>
  );
}

/**
 * Renders an AI answer: GitHub Markdown (tables, lists), math ($…$, $$…$$) and highlighted
 * code with a copy button. Raw HTML in the answer is not rendered (react-markdown default).
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, [rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => (
            <div className="relative my-2">
              <div className="absolute top-1 right-1">
                <CopyButton text={textOf(children)} label="Chép code" />
              </div>
              <pre className="overflow-x-auto rounded bg-slate-50 p-3 text-xs">{children}</pre>
            </div>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="border-collapse text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-slate-300 bg-slate-100 px-2 py-1 text-left">{children}</th>
          ),
          td: ({ children }) => <td className="border border-slate-300 px-2 py-1">{children}</td>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-sky-800 underline"
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
