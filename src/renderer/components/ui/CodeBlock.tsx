import { useCallback, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '../../lib/utils';
import { focusRing } from './styles';

export interface CodeBlockProps {
  /** The text to render. Objects should be stringified by the caller. */
  code: string;
  /** Label shown top-left, e.g. `json`, `bash`, `stderr`. */
  language?: string;
  /** Show the copy button. Default true. */
  copyable?: boolean;
  /** Soft-wrap long lines instead of scrolling horizontally. */
  wrap?: boolean;
  /** Gutter line numbers. Useful for memory chunks with line provenance. */
  showLineNumbers?: boolean;
  /** First line number, for a chunk that starts mid-file. */
  startLine?: number;
  /** CSS max-height, e.g. `'20rem'`. Scrolls vertically beyond it. */
  maxHeight?: string;
  /** Extra header content, right-aligned next to the copy button. */
  actions?: ReactNode;
  className?: string;
}

/**
 * Monospaced, horizontally scrollable block for raw payloads: tool arguments,
 * commands, stderr, JSON.
 *
 * No syntax highlighting on purpose — a highlighter is a dependency and a
 * performance cliff on a streaming timeline. Contrast and alignment do the
 * work instead.
 */
export function CodeBlock({
  code,
  language,
  copyable = true,
  wrap = false,
  showLineNumbers = false,
  startLine = 1,
  maxHeight,
  actions,
  className,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => setCopied(false));
  }, [code]);

  const lines = showLineNumbers ? code.split('\n') : null;
  const showHeader = Boolean(language) || copyable || Boolean(actions);

  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950',
        className,
      )}
    >
      {showHeader ? (
        <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-2 py-1 dark:border-zinc-800">
          <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            {language ?? ''}
          </span>
          <div className="flex items-center gap-1">
            {actions}
            {copyable ? (
              <button
                type="button"
                onClick={copy}
                aria-label={copied ? 'Copied' : 'Copy to clipboard'}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-500 transition-colors',
                  'hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200',
                  focusRing,
                )}
              >
                {copied ? (
                  <Check size={11} aria-hidden="true" />
                ) : (
                  <Copy size={11} aria-hidden="true" />
                )}
                {copied ? 'Copied' : 'Copy'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto" style={{ maxHeight }}>
        <pre
          className={cn(
            'px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-zinc-800 dark:text-zinc-200',
            wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre',
          )}
        >
          {lines ? (
            lines.map((line, index) => (
              // Line order is stable for a given code string.
              // eslint-disable-next-line react/no-array-index-key
              <div key={index} className="flex">
                <span className="mr-3 w-8 shrink-0 select-none text-right text-zinc-300 dark:text-zinc-600">
                  {startLine + index}
                </span>
                <span className="flex-1">{line || ' '}</span>
              </div>
            ))
          ) : (
            <code>{code}</code>
          )}
        </pre>
      </div>
    </div>
  );
}

export default CodeBlock;
