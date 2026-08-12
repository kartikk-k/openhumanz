/**
 * The home screen's Markdown renderer — dark, ambient, and font-size-relative.
 *
 * This is a sibling to the chat tab's `components/ui/Markdown.tsx`, not a
 * replacement. Both reuse the same security-hardened, streaming-safe parser
 * (`lib/markdown.ts`) — which returns a *structure*, never an HTML string, so
 * there is no `dangerouslySetInnerHTML` in the path and half-written Markdown
 * (an unclosed ``` fence, a dangling `[link`) degrades gracefully token by
 * token. What differs is the presentation:
 *
 *  - **Dark ambient palette.** This renders on the near-black home background,
 *    so body text is `text-white/85`, headings step up to full `text-white`,
 *    and links are a soft indigo. Contrast, not chrome, carries the hierarchy.
 *
 *  - **Everything is `em`-relative.** The outer wrapper deliberately sets no
 *    font-size — it inherits whatever base the parent container establishes —
 *    and every heading, list item and gap below is expressed in `em`. Set one
 *    `fontSize` on the container and the whole block scales in proportion.
 *
 * Code fences render through the shared {@link CodeBlock} (it already supports
 * dark mode). Links open in the OS browser: `target="_blank"` is load-bearing,
 * because main's `setWindowOpenHandler` routes those out to the system browser
 * (the scheme was whitelisted at parse time) rather than replacing the app.
 * React escapes every text node the parser hands back.
 */
import { Fragment, useMemo, type ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import {
  parseMarkdown,
  type Block,
  type InlineNode,
} from '../../../lib/markdown';
import { CodeBlock } from '../../../components/ui/CodeBlock';

const LINK_CLASS =
  'rounded-sm text-indigo-300 underline decoration-indigo-400/40 underline-offset-2 hover:decoration-indigo-400';

const INLINE_CODE_CLASS =
  'font-mono rounded bg-white/10 border border-white/10 px-1 py-px text-[0.85em] text-white/90';

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
              <strong key={key} className="font-semibold text-white">
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
              <s key={key} className="line-through opacity-70">
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
            // Vault-relative memory links have no destination on the home
            // screen — render the label as plain text rather than a dead
            // control.
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

// All sizes in `em` so a parent `fontSize` scales the whole hierarchy. Weight
// and the brighter `text-white` (vs. the body's `text-white/85`) reinforce the
// steps between levels alongside size.
const HEADING_STYLE: Record<number, React.CSSProperties> = {
  1: { fontSize: '1.5em', fontWeight: 600, letterSpacing: '-0.02em' },
  2: { fontSize: '1.3em', fontWeight: 600, letterSpacing: '-0.01em' },
  3: { fontSize: '1.15em', fontWeight: 600 },
  4: { fontSize: '1em', fontWeight: 600 },
  5: { fontSize: '0.95em', fontWeight: 600 },
  6: { fontSize: '0.85em', fontWeight: 600 },
};

const HEADING_CLASS: Record<number, string> = {
  1: 'text-white mt-[0.4em]',
  2: 'text-white mt-[0.2em]',
  3: 'text-white',
  4: 'text-white',
  5: 'text-white',
  6: 'text-white uppercase tracking-wide',
};

function BlockBody({ block }: { block: Block }): ReactNode {
  switch (block.kind) {
    case 'frontmatter':
      // Home prose never opens with YAML front matter; if a stray `---` pair is
      // parsed as one, show it as a plain fenced block rather than dropping it.
      return (
        <CodeBlock code={block.text} language="text" copyable={false} wrap />
      );

    case 'heading': {
      const level = Math.min(6, Math.max(1, block.level));
      const Tag = `h${level}` as 'h1';
      return (
        <Tag
          style={HEADING_STYLE[level] ?? HEADING_STYLE[6]}
          className={HEADING_CLASS[level] ?? HEADING_CLASS[6]}
        >
          <InlineNodes nodes={block.inline} />
        </Tag>
      );
    }

    case 'paragraph':
      return (
        <p
          className="whitespace-pre-wrap break-words text-white/85"
          style={{ fontSize: '1em' }}
        >
          <InlineNodes nodes={block.inline} />
        </p>
      );

    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul';
      return (
        <Tag
          start={block.ordered ? block.start : undefined}
          className={cn(
            'space-y-1 pl-5 text-white/85',
            block.ordered ? 'list-decimal' : 'list-disc',
          )}
        >
          {block.items.map((item, index) => (
            <li
              // Items are positional; the list is re-parsed whole on change.
              // eslint-disable-next-line react/no-array-index-key
              key={index}
              style={{ fontSize: '1em', marginLeft: `${item.depth}em` }}
              className={cn(
                'break-words',
                item.checked === true && 'line-through opacity-60',
              )}
            >
              {item.checked !== null ? (
                <input
                  type="checkbox"
                  checked={item.checked}
                  readOnly
                  tabIndex={-1}
                  className="mr-[0.4em] h-[0.85em] w-[0.85em] shrink-0 align-[-0.05em] accent-indigo-500"
                />
              ) : null}
              <InlineNodes nodes={item.inline} />
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
              <span className="text-[10px] font-medium uppercase tracking-wide text-amber-400">
                unclosed fence
              </span>
            ) : null
          }
        />
      );

    case 'quote':
      return (
        <blockquote className="space-y-2 border-l-2 border-white/20 pl-3 italic text-white/70">
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
      return <hr className="border-white/15" />;

    case 'truncated':
      return (
        <p className="rounded-md border border-dashed border-white/20 px-3 py-2 text-[0.85em] text-white/60">
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
 * Render a Markdown string for the home screen's dark, ambient surface.
 *
 * The outer wrapper sets no font-size on purpose: it inherits the base from the
 * parent container, and everything inside is `em`-relative, so a single
 * `fontSize` on that container scales the whole block. Safe to re-render on
 * every streamed token — incomplete Markdown parses best-effort and never
 * throws.
 */
export function HomeMarkdown({ children }: { children: string }) {
  const blocks = useMemo(() => parseMarkdown(children).blocks, [children]);

  return (
    <div className="space-y-2 leading-relaxed text-white/85">
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

export default HomeMarkdown;
