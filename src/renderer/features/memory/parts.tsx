/**
 * Small pieces the memory screen uses in more than one place.
 *
 *  - {@link CopyButton}   copy-to-clipboard with a settled state
 *  - {@link Provenance}   doc path + heading breadcrumb + line range, the chip
 *                         that has to appear on every retrieved chunk
 *  - {@link RawDocument}  the file exactly as it is on disk, with real line
 *                         numbers and the chunk's lines highlighted
 *  - {@link ChannelNotice} what a failed IPC channel looks like — which, until
 *                         the backend is wired to the UI, is every channel
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Check,
  ChevronRight,
  Copy,
  FileText,
  PlugZap,
  TriangleAlert,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { Badge, Button } from '../../components/ui';
import { mono, textMuted } from '../../components/ui/styles';
import type { IpcError } from '../../lib/ipc';
import type { LineRange } from './MarkdownView';

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

export interface CopyButtonProps {
  value: string;
  /** Shown next to the icon. Omit for an icon-only button. */
  label?: string;
  /** Announced and tooltipped. */
  title?: string;
  size?: 'xs' | 'sm';
  variant?: 'ghost' | 'outline' | 'secondary';
  className?: string;
}

/**
 * Copy one string. Used for absolute paths, which is the closest this screen
 * can currently get to "open in editor" — see the note in `DocumentPane`.
 */
export function CopyButton({
  value,
  label,
  title,
  size = 'xs',
  variant = 'ghost',
  className,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }, [value]);

  return (
    <Button
      size={label ? size : 'icon-sm'}
      variant={variant}
      icon={copied ? Check : Copy}
      title={title ?? `Copy ${label ?? 'to clipboard'}`}
      aria-label={title ?? `Copy ${label ?? 'to clipboard'}`}
      className={className}
      onClick={() => {
        void copy();
      }}
    >
      {label && (copied ? 'Copied' : label)}
    </Button>
  );
}

/* ------------------------------------------------------------------ */
/* Provenance                                                          */
/* ------------------------------------------------------------------ */

export interface ProvenanceProps {
  /** Vault-relative path of the source document. */
  docPath: string;
  /** `People > Ana > Preferences`, as built by the chunker. Often empty. */
  heading?: string;
  /** 1-based inclusive, straight off the chunk. */
  startLine?: number;
  endLine?: number;
  className?: string;
}

/** `12–18` or `12`. */
export function formatLineRange(start?: number, end?: number): string {
  if (start === undefined) return '';
  if (end === undefined || end <= start) return `L${start}`;
  return `L${start}–${end}`;
}

/**
 * Where a piece of text came from.
 *
 * ARCHITECTURE.md is explicit that provenance is on every retrieved chunk, so
 * this component exists to make that a single thing to render rather than three
 * things to remember.
 */
export function Provenance({
  docPath,
  heading,
  startLine,
  endLine,
  className,
}: ProvenanceProps) {
  const crumbs = (heading ?? '')
    .split('>')
    .map((part) => part.trim())
    .filter(Boolean);

  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px]',
        textMuted,
        className,
      )}
    >
      <FileText size={11} aria-hidden="true" className="shrink-0" />
      <span className={cn('truncate', mono)} title={docPath}>
        {docPath}
      </span>
      {crumbs.map((crumb) => (
        <span key={crumb} className="flex min-w-0 items-center gap-1">
          <ChevronRight
            size={10}
            aria-hidden="true"
            className="shrink-0 opacity-60"
          />
          <span className="truncate">{crumb}</span>
        </span>
      ))}
      {startLine !== undefined ? (
        <Badge tone="neutral" variant="outline" className={mono}>
          {formatLineRange(startLine, endLine)}
        </Badge>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Raw document                                                        */
/* ------------------------------------------------------------------ */

export interface RawDocumentProps {
  content: string;
  highlight?: LineRange | null;
  focusRef?: (node: HTMLDivElement | null) => void;
  className?: string;
}

/** Beyond this the raw view stops numbering lines and just shows the text. */
const RAW_LINE_LIMIT = 20000;

/**
 * The file, verbatim.
 *
 * `CodeBlock` numbers lines but cannot highlight a range, and the range is the
 * whole point here — this is the view that proves a chunk's `startLine` and
 * `endLine` actually point where the search said they did.
 */
export function RawDocument({
  content,
  highlight,
  focusRef,
  className,
}: RawDocumentProps) {
  const lines = content.split('\n');
  const capped = lines.length > RAW_LINE_LIMIT;
  const shown = capped ? lines.slice(0, RAW_LINE_LIMIT) : lines;
  const gutter = String(shown.length).length;
  let focusAssigned = false;

  return (
    <div data-selectable className={cn('pb-16', className)}>
      <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.65] text-zinc-700 dark:text-zinc-300">
        {shown.map((line, index) => {
          const number = index + 1;
          const lit = Boolean(
            highlight &&
            number >= highlight.startLine &&
            number <= highlight.endLine,
          );
          const isFirstLit = lit && !focusAssigned;
          if (isFirstLit) focusAssigned = true;
          return (
            <div
              // Line numbers are the identity here.
              // eslint-disable-next-line react/no-array-index-key
              key={index}
              ref={isFirstLit ? focusRef : undefined}
              className={cn(
                'flex scroll-mt-24',
                lit &&
                  'bg-amber-50 dark:bg-amber-500/[0.09] border-l-2 border-amber-400 -ml-[2px] dark:border-amber-500/70',
              )}
            >
              <span
                aria-hidden="true"
                style={{ width: `${gutter + 1}ch` }}
                className="mr-3 shrink-0 select-none text-right tabular-nums text-zinc-300 dark:text-zinc-600"
              >
                {number}
              </span>
              <span className="min-w-0 flex-1">{line || ' '}</span>
            </div>
          );
        })}
      </pre>
      {capped ? (
        <p className={cn('mt-3 text-xs', textMuted)}>
          Showing the first {RAW_LINE_LIMIT.toLocaleString()} of{' '}
          {lines.length.toLocaleString()} lines.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Channel failures                                                    */
/* ------------------------------------------------------------------ */

export interface ChannelNoticeProps {
  error: IpcError;
  /** What could not be loaded, lower case: `the vault`, `the index status`. */
  what: string;
  onRetry?: () => void;
  /** `inline` is a one-line strip; `panel` fills an empty pane. */
  variant?: 'inline' | 'panel';
  className?: string;
}

interface NoticeCopy {
  title: string;
  body: ReactNode;
}

function noticeCopy(error: IpcError, what: string): NoticeCopy {
  if (error.code === 'bridge_unavailable') {
    return {
      title: `Not connected to the app, so ${what} cannot load`,
      body: 'This window is running outside Electron — the preload bridge that carries IPC is not installed. Nothing is wrong with the vault; the renderer simply has no way to reach it.',
    };
  }
  if (error.code === 'no_handler') {
    return {
      title: `The memory module has not started yet`,
      body: `Main has not registered ${error.channel}. It appears once the module finishes its first index.`,
    };
  }
  return {
    title: `Could not load ${what}`,
    body: (
      <>
        {error.message}{' '}
        <span className={mono}>
          ({error.channel} · {error.code})
        </span>
      </>
    ),
  };
}

/**
 * How a dead channel looks.
 *
 * The backend is not wired to the UI yet, so today this renders on every
 * screen load. It has to read as a state of the system, not as a crash.
 */
export function ChannelNotice({
  error,
  what,
  onRetry,
  variant = 'panel',
  className,
}: ChannelNoticeProps) {
  const copy = noticeCopy(error, what);
  const Icon = error.isUnavailable ? PlugZap : TriangleAlert;
  const tone = error.isUnavailable
    ? 'text-amber-600 dark:text-amber-400'
    : 'text-rose-600 dark:text-rose-400';

  if (variant === 'inline') {
    return (
      <div
        className={cn(
          'flex items-center gap-2 border-b border-zinc-200 bg-zinc-50 px-5 py-1.5 text-[11px] dark:border-zinc-800 dark:bg-zinc-900/60',
          className,
        )}
      >
        <Icon size={12} aria-hidden="true" className={cn('shrink-0', tone)} />
        <span className={cn('truncate', textMuted)}>{copy.title}.</span>
        {onRetry ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={onRetry}
            className="ml-auto"
          >
            Retry
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'mx-auto flex max-w-md flex-col items-center gap-2.5 px-6 py-14 text-center',
        className,
      )}
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
        <Icon size={19} aria-hidden="true" className={tone} />
      </div>
      <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
        {copy.title}
      </p>
      <p className={cn('text-xs leading-relaxed', textMuted)}>{copy.body}</p>
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry} className="mt-1">
          Try again
        </Button>
      ) : null}
    </div>
  );
}
