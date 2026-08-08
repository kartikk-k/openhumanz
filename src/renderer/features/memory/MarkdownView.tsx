/**
 * Renders the structure produced by `markdown.ts` as React elements.
 *
 * There is no `dangerouslySetInnerHTML` in this file and there must never be
 * one: the vault holds text that may have arrived from an email, and the whole
 * reason the parser returns a tree instead of an HTML string is so that React's
 * escaping is doing the sanitising rather than a regex somewhere.
 *
 * Two things beyond plain rendering:
 *
 *  - **Line provenance.** Every block carries the 1-based inclusive line range
 *    it came from, so a search hit's `startLine`/`endLine` can be highlighted
 *    in place and scrolled to.
 *  - **Term marking.** The words the search matched are marked inside the
 *    prose, so the eye lands on the same thing the index did.
 */
import { Fragment, useMemo, type ReactNode, type Ref } from 'react';
import { cn } from '../../lib/utils';
import { CodeBlock } from '../../components/ui';
import { textMuted } from '../../components/ui/styles';
import {
  inlineText,
  parseMarkdown,
  type Block,
  type InlineNode,
  type Span,
} from './markdown';

export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface MarkdownViewProps {
  source: string;
  /** Vault path of the document — resolves relative links to other notes. */
  docPath: string;
  /** Lines to highlight, from a search hit's chunk. */
  highlight?: LineRange | null;
  /** Words to mark inside the prose. Lower-cased by the caller or here. */
  terms?: readonly string[];
  /** Attached to the first highlighted block, so the caller can scroll to it. */
  focusRef?: Ref<HTMLDivElement>;
  /** Clicking a link to another `.md` in the vault. */
  onOpenDoc?: (path: string) => void;
  className?: string;
}

/* ------------------------------------------------------------------ */
/* Term marking                                                        */
/* ------------------------------------------------------------------ */

const MAX_TERMS = 8;
const MIN_TERM = 2;

/** Tokenise a search query into the words worth marking in the body. */
export function markableTerms(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of query.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const term = match[0].toLowerCase();
    if (term.length < MIN_TERM || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/**
 * Split a run of text on any of `terms`, case-insensitively.
 *
 * Scans with `indexOf` rather than building a regex from user input — a
 * hand-built alternation of arbitrary words is one unescaped `(` away from
 * throwing, and one nested quantifier away from hanging.
 */
function markText(text: string, terms: readonly string[]): ReactNode {
  if (terms.length === 0 || text.length > 20_000) return text;
  const haystack = text.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  while (cursor < text.length) {
    let bestAt = -1;
    let bestLength = 0;
    for (const term of terms) {
      const at = haystack.indexOf(term, cursor);
      if (at !== -1 && (bestAt === -1 || at < bestAt)) {
        bestAt = at;
        bestLength = term.length;
      }
    }
    if (bestAt === -1) break;
    if (bestAt > cursor) parts.push(text.slice(cursor, bestAt));
    key += 1;
    parts.push(
      <mark
        key={`m${key}`}
        className="rounded-[2px] bg-amber-200/70 px-px text-inherit dark:bg-amber-400/25"
      >
        {text.slice(bestAt, bestAt + bestLength)}
      </mark>,
    );
    cursor = bestAt + bestLength;
  }

  if (parts.length === 0) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/* ------------------------------------------------------------------ */
/* Inline                                                              */
/* ------------------------------------------------------------------ */

interface InlineProps {
  nodes: readonly InlineNode[];
  terms: readonly string[];
  onOpenDoc?: (path: string) => void;
}

const LINK_CLASS =
  'rounded-sm text-indigo-600 underline decoration-indigo-300 underline-offset-2 hover:decoration-indigo-500 dark:text-indigo-400 dark:decoration-indigo-500/50';

function Inline({ nodes, terms, onOpenDoc }: InlineProps) {
  return (
    <>
      {nodes.map((node, index) => {
        const key = `${node.kind}-${index}`;
        switch (node.kind) {
          case 'text':
            return <Fragment key={key}>{markText(node.value, terms)}</Fragment>;
          case 'code':
            return (
              <code
                key={key}
                className="rounded border border-zinc-200 bg-zinc-100 px-1 py-px font-mono text-[0.85em] text-zinc-800 dark:border-zinc-700/60 dark:bg-zinc-800 dark:text-zinc-200"
              >
                {markText(node.value, terms)}
              </code>
            );
          case 'strong':
            return (
              <strong
                key={key}
                className="font-semibold text-zinc-900 dark:text-zinc-100"
              >
                <Inline
                  nodes={node.children}
                  terms={terms}
                  onOpenDoc={onOpenDoc}
                />
              </strong>
            );
          case 'em':
            return (
              <em key={key} className="italic">
                <Inline
                  nodes={node.children}
                  terms={terms}
                  onOpenDoc={onOpenDoc}
                />
              </em>
            );
          case 'strike':
            return (
              <s key={key} className="text-zinc-400 dark:text-zinc-500">
                <Inline
                  nodes={node.children}
                  terms={terms}
                  onOpenDoc={onOpenDoc}
                />
              </s>
            );
          case 'link':
            // `target="_blank"` is load-bearing: main's `setWindowOpenHandler`
            // sends it to the OS browser, whereas a same-window navigation
            // would replace the app. The scheme was whitelisted at parse time.
            return (
              <a
                key={key}
                href={node.href}
                title={node.href}
                target="_blank"
                rel="noreferrer noopener"
                className={LINK_CLASS}
              >
                <Inline
                  nodes={node.children}
                  terms={terms}
                  onOpenDoc={onOpenDoc}
                />
              </a>
            );
          case 'doclink':
            return (
              <button
                key={key}
                type="button"
                title={node.path}
                disabled={!onOpenDoc}
                onClick={() => onOpenDoc?.(node.path)}
                className={cn(LINK_CLASS, 'disabled:no-underline')}
              >
                <Inline
                  nodes={node.children}
                  terms={terms}
                  onOpenDoc={onOpenDoc}
                />
              </button>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Blocks                                                              */
/* ------------------------------------------------------------------ */

const HEADING_CLASS: Record<number, string> = {
  1: 'text-[17px] font-semibold tracking-tight mt-6 first:mt-0',
  2: 'text-[15px] font-semibold tracking-tight mt-6 first:mt-0',
  3: 'text-[13.5px] font-semibold mt-5 first:mt-0',
  4: 'text-[13px] font-semibold mt-4 first:mt-0',
  5: 'text-[12.5px] font-semibold mt-4 first:mt-0',
  6: 'text-[12px] font-semibold uppercase tracking-wide mt-4 first:mt-0',
};

function overlaps(span: Span, range: LineRange | null | undefined): boolean {
  if (!range) return false;
  return span.startLine <= range.endLine && span.endLine >= range.startLine;
}

interface BlockProps {
  block: Block;
  terms: readonly string[];
  onOpenDoc?: (path: string) => void;
}

function BlockBody({ block, terms, onOpenDoc }: BlockProps) {
  switch (block.kind) {
    case 'frontmatter':
      return (
        <div className="mb-4">
          <CodeBlock
            code={block.text}
            language="front matter"
            copyable={false}
            wrap
            maxHeight="12rem"
          />
        </div>
      );

    case 'heading': {
      const Tag = `h${Math.min(6, Math.max(1, block.level))}` as 'h1';
      return (
        <Tag
          className={cn(
            'mb-2 text-zinc-900 dark:text-zinc-100',
            HEADING_CLASS[block.level] ?? HEADING_CLASS[6],
          )}
        >
          <Inline nodes={block.inline} terms={terms} onOpenDoc={onOpenDoc} />
        </Tag>
      );
    }

    case 'paragraph':
      return (
        <p className="my-2.5 whitespace-pre-wrap break-words text-[13px] leading-[1.7] text-zinc-700 dark:text-zinc-300">
          <Inline nodes={block.inline} terms={terms} onOpenDoc={onOpenDoc} />
        </p>
      );

    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag
          start={block.ordered ? block.start : undefined}
          className="my-2.5 space-y-1 text-[13px] leading-[1.65] text-zinc-700 dark:text-zinc-300"
        >
          {block.items.map((item, index) => (
            <li
              // Items are positional; the list is re-parsed whole on change.
              // eslint-disable-next-line react/no-array-index-key
              key={index}
              style={{ marginLeft: `${item.depth * 16}px` }}
              className="flex gap-2"
            >
              {item.checked === null ? (
                <span
                  aria-hidden="true"
                  className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-zinc-400 dark:bg-zinc-600"
                />
              ) : (
                <input
                  type="checkbox"
                  checked={item.checked}
                  readOnly
                  tabIndex={-1}
                  aria-label={inlineText(item.inline)}
                  className="mt-[3px] h-3 w-3 shrink-0 accent-indigo-600"
                />
              )}
              <span
                className={cn(
                  'min-w-0 break-words',
                  item.checked === true &&
                    'text-zinc-400 line-through dark:text-zinc-500',
                )}
              >
                <Inline
                  nodes={item.inline}
                  terms={terms}
                  onOpenDoc={onOpenDoc}
                />
              </span>
            </li>
          ))}
        </Tag>
      );
    }

    case 'code':
      return (
        <div className="my-3">
          <CodeBlock
            code={block.code}
            language={block.language || 'text'}
            wrap
            maxHeight="24rem"
            actions={
              block.unterminated ? (
                <span className="text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
                  unclosed fence
                </span>
              ) : null
            }
          />
        </div>
      );

    case 'quote':
      return (
        <blockquote className="my-3 border-l-2 border-zinc-300 pl-3 dark:border-zinc-700">
          {block.blocks.map((child) => (
            <BlockBody
              key={`${child.kind}-${child.startLine}`}
              block={child}
              terms={terms}
              onOpenDoc={onOpenDoc}
            />
          ))}
        </blockquote>
      );

    case 'rule':
      return <hr className="my-5 border-zinc-200 dark:border-zinc-800" />;

    case 'truncated':
      return (
        <p
          className={cn(
            'my-3 rounded-md border border-dashed border-zinc-300 px-3 py-2 text-xs dark:border-zinc-700',
            textMuted,
          )}
        >
          {block.reason}
        </p>
      );

    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export function MarkdownView({
  source,
  docPath,
  highlight,
  terms = [],
  focusRef,
  onOpenDoc,
  className,
}: MarkdownViewProps) {
  const parsed = useMemo(
    () => parseMarkdown(source, docPath),
    [source, docPath],
  );

  const firstHighlighted = useMemo(() => {
    if (!highlight) return -1;
    return parsed.blocks.findIndex((block) => overlaps(block, highlight));
  }, [parsed.blocks, highlight]);

  if (parsed.blocks.length === 0) {
    return (
      <p className={cn('py-6 text-center text-xs', textMuted, className)}>
        This note is empty.
      </p>
    );
  }

  return (
    <div data-selectable className={cn('pb-16', className)}>
      {parsed.blocks.map((block, index) => {
        const lit = overlaps(block, highlight);
        return (
          <div
            // Blocks are positional: the document is re-parsed whole whenever
            // it changes, so there is nothing stabler than the position.
            // eslint-disable-next-line react/no-array-index-key
            key={`${block.kind}-${block.startLine}-${index}`}
            ref={index === firstHighlighted ? focusRef : undefined}
            data-line={block.startLine}
            className={cn(
              'relative scroll-mt-24 rounded-r-sm transition-colors',
              lit &&
                'border-l-2 border-amber-400 bg-amber-50/70 pl-3 dark:border-amber-500/70 dark:bg-amber-500/[0.07]',
            )}
          >
            <BlockBody block={block} terms={terms} onOpenDoc={onOpenDoc} />
          </div>
        );
      })}
    </div>
  );
}

export default MarkdownView;
