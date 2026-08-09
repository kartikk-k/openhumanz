/**
 * Renders an assistant chat message written in Markdown.
 *
 * The chat timeline used to show assistant text through `whitespace-pre-wrap`,
 * so `## heading`, `**bold**` and code fences arrived on screen as their literal
 * source. This renders them properly instead, tuned for a ~13.5px chat bubble.
 *
 * ## Why it borrows the memory parser
 *
 * The vault already ships a small, security-hardened Markdown parser
 * (`lib/markdown.ts`) that returns a *structure* rather than an HTML
 * string — no `dangerouslySetInnerHTML` anywhere in the path — with URL schemes
 * whitelisted to http/https/mailto, hard caps against pathological input, and,
 * crucially here, graceful handling of half-written Markdown: an unclosed ```
 * fence becomes a `code` block flagged `unterminated`, and a dangling `[link`
 * stays literal text. That is exactly what a token-by-token streaming response
 * needs, so this component reuses `parseMarkdown` and only supplies its own
 * chat-tuned React rendering. Nothing here produces raw HTML; React escapes the
 * text nodes the parser hands back.
 *
 * Code fences render through the shared {@link CodeBlock}. Links open in the
 * user's browser: `target="_blank"` is load-bearing, because main's
 * `setWindowOpenHandler` routes those to the OS browser (the scheme was already
 * whitelisted at parse time) while a same-window navigation would replace the
 * app.
 */
import { Fragment, useMemo, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { parseMarkdown, type Block, type InlineNode } from '../../lib/markdown';
import { CodeBlock } from './CodeBlock';
import { mono, textMuted } from './styles';

const LINK_CLASS =
  'rounded-sm text-indigo-600 underline decoration-indigo-300 underline-offset-2 hover:decoration-indigo-500 dark:text-indigo-400 dark:decoration-indigo-500/50';

const INLINE_CODE_CLASS = cn(
  mono,
  'rounded border border-zinc-200 bg-zinc-100 px-1 py-px text-[0.85em] text-zinc-800 dark:border-zinc-700/60 dark:bg-zinc-800 dark:text-zinc-200',
);

/* ------------------------------------------------------------------ */
/* Inline                                                              */
/* ------------------------------------------------------------------ */

function InlineNodes({ nodes }: { nodes: readonly InlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        // Nodes are positional: the message is re-parsed whole on every token,
        // so there is nothing stabler to key on than the index.
        const key = `${node.kind}-${index}`;
        switch (node.kind) {
          case 'text':
            return <Fragment key={key}>{node.value}</Fragment>;
          case 'code':
            return (
              <code key={key} className={INLINE_CODE_CLASS}>
                {node.value}
              </code>
            );
          case 'strong':
            return (
              <strong
                key={key}
                className="font-semibold text-zinc-900 dark:text-zinc-100"
              >
                <InlineNodes nodes={node.children} />
              </strong>
            );
          case 'em':
            return (
              <em key={key} className="italic">
                <InlineNodes nodes={node.children} />
              </em>
            );
          case 'strike':
            return (
              <s key={key} className="text-zinc-400 dark:text-zinc-500">
                <InlineNodes nodes={node.children} />
              </s>
            );
          case 'link':
            // The scheme was whitelisted at parse time; `target="_blank"` sends
            // the click to the OS browser via main's window-open handler.
            return (
              <a
                key={key}
                href={node.href}
                title={node.href}
                target="_blank"
                rel="noreferrer noopener"
                className={LINK_CLASS}
              >
                <InlineNodes nodes={node.children} />
              </a>
            );
          case 'doclink':
            // Vault-relative links have no meaning in a chat bubble — render the
            // label as plain text rather than a dead control.
            return (
              <Fragment key={key}>
                <InlineNodes nodes={node.children} />
              </Fragment>
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
  1: 'text-[15px] font-semibold tracking-tight',
  2: 'text-[14.5px] font-semibold tracking-tight',
  3: 'text-[14px] font-semibold',
  4: 'text-[13.5px] font-semibold',
  5: 'text-[13px] font-semibold',
  6: 'text-[12.5px] font-semibold uppercase tracking-wide',
};

function BlockBody({ block }: { block: Block }): ReactNode {
  switch (block.kind) {
    case 'frontmatter':
      // Assistant prose never opens with YAML front matter; if a stray `---`
      // pair is parsed as one, show it as a plain fenced block.
      return (
        <CodeBlock code={block.text} language="text" copyable={false} wrap />
      );

    case 'heading': {
      const level = Math.min(6, Math.max(1, block.level));
      const Tag = `h${level}` as 'h1';
      return (
        <Tag
          className={cn(
            'text-zinc-900 dark:text-zinc-100',
            HEADING_CLASS[level] ?? HEADING_CLASS[6],
          )}
        >
          <InlineNodes nodes={block.inline} />
        </Tag>
      );
    }

    case 'paragraph':
      return (
        <p className="whitespace-pre-wrap break-words">
          <InlineNodes nodes={block.inline} />
        </p>
      );

    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag
          start={block.ordered ? block.start : undefined}
          className="space-y-0.5"
        >
          {block.items.map((item, index) => (
            <li
              // Items are positional; the list is re-parsed whole on change.
              // eslint-disable-next-line react/no-array-index-key
              key={index}
              style={{ marginLeft: `${item.depth * 14}px` }}
              className="flex gap-2"
            >
              {item.checked === null ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-[7px] h-1 w-1 shrink-0 rounded-full bg-zinc-400 dark:bg-zinc-600',
                    block.ordered && 'hidden',
                  )}
                />
              ) : (
                <input
                  type="checkbox"
                  checked={item.checked}
                  readOnly
                  tabIndex={-1}
                  className="mt-[3px] h-3 w-3 shrink-0 accent-indigo-600"
                />
              )}
              {block.ordered ? (
                <span className="mt-px shrink-0 tabular-nums text-zinc-400 dark:text-zinc-500">
                  {block.start + index}.
                </span>
              ) : null}
              <span
                className={cn(
                  'min-w-0 break-words',
                  item.checked === true &&
                    'text-zinc-400 line-through dark:text-zinc-500',
                )}
              >
                <InlineNodes nodes={item.inline} />
              </span>
            </li>
          ))}
        </Tag>
      );
    }

    case 'code':
      return (
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
      );

    case 'quote':
      return (
        <blockquote className="space-y-2 border-l-2 border-zinc-300 pl-3 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
          {block.blocks.map((child, index) => (
            <BlockBody
              // eslint-disable-next-line react/no-array-index-key
              key={`${child.kind}-${child.startLine}-${index}`}
              block={child}
            />
          ))}
        </blockquote>
      );

    case 'rule':
      return <hr className="border-zinc-200 dark:border-zinc-800" />;

    case 'truncated':
      return (
        <p
          className={cn(
            'rounded-md border border-dashed border-zinc-300 px-3 py-2 text-xs dark:border-zinc-700',
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
/* Component                                                           */
/* ------------------------------------------------------------------ */

/**
 * Render a Markdown string as chat prose.
 *
 * Safe to re-render on every streamed token: incomplete Markdown (an unclosed
 * fence, a half-typed link) parses best-effort and never throws.
 */
export function Markdown({ children }: { children: string }) {
  const blocks = useMemo(() => parseMarkdown(children).blocks, [children]);

  return (
    <div className="space-y-2 text-[13.5px] leading-relaxed text-zinc-800 dark:text-zinc-100">
      {blocks.map((block, index) => (
        <BlockBody
          // Blocks are positional: the message is re-parsed whole on change.
          // eslint-disable-next-line react/no-array-index-key
          key={`${block.kind}-${block.startLine}-${index}`}
          block={block}
        />
      ))}
    </div>
  );
}

export default Markdown;
