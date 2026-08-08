/**
 * A small, deliberately incomplete Markdown parser.
 *
 * Why this exists: the vault is Markdown and the memory browser has to render
 * it, but a Markdown library is a dependency this project has not approved and
 * every one of them ships an HTML string that you then have to hand to
 * `dangerouslySetInnerHTML`. This vault holds text that may have arrived from
 * an email, so that route is not available at any price.
 *
 * So this file parses to a *structure*. It never produces HTML, never produces
 * a string that anything downstream will interpret, and `MarkdownView.tsx`
 * turns the structure into React elements — which React escapes for us.
 *
 * What it understands: front matter, ATX headings, fenced code, blockquotes,
 * bullet and ordered lists (with task checkboxes), thematic breaks,
 * paragraphs, and inline code / strong / emphasis / strikethrough / links /
 * autolinks / backslash escapes.
 *
 * What it deliberately does not: raw HTML (rendered as literal text — that is
 * the point), reference links, setext headings, tables, footnotes.
 *
 * Every block carries a **1-based inclusive line range**, matching the
 * provenance a search hit carries, so the preview can highlight exactly the
 * lines a chunk came from.
 *
 * ## Hostile input
 *
 * The parser is written against text an attacker may have authored:
 *
 *  - **URL schemes are whitelisted** ({@link safeHref}) to http/https/mailto.
 *    `javascript:`, `data:`, `vbscript:` and friends never become an anchor;
 *    they render as the literal text they are.
 *  - **No quadratic scanning.** Every unmatched delimiter is remembered
 *    (`missing`), so a line of ten thousand `*` characters costs one scan, not
 *    ten thousand.
 *  - **Hard caps** on line length, inline length, nesting depth and block
 *    count, so a 40 MB single-line file degrades to a truncation notice
 *    instead of freezing the renderer.
 */

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

/** Longer lines are cut for display. A minified blob is not prose. */
export const MAX_LINE_CHARS = 2000;
/** Above this, a run of inline text is left alone as plain text. */
export const MAX_INLINE_CHARS = 8000;
/** Emphasis inside emphasis inside emphasis. Four is already generous. */
export const MAX_INLINE_DEPTH = 4;
/** Blockquote inside blockquote. */
export const MAX_QUOTE_DEPTH = 3;
/** Stop parsing after this many blocks and say so. */
export const MAX_BLOCKS = 4000;
/** Stop parsing after this many lines and say so. */
export const MAX_LINES = 20000;
/** Above this, the preview offers raw text first. */
export const LARGE_DOC_CHARS = 400_000;

/* ------------------------------------------------------------------ */
/* Inline nodes                                                        */
/* ------------------------------------------------------------------ */

export type InlineNode =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'strong'; children: InlineNode[] }
  | { kind: 'em'; children: InlineNode[] }
  | { kind: 'strike'; children: InlineNode[] }
  /** An external link. `href` has already passed {@link safeHref}. */
  | { kind: 'link'; href: string; children: InlineNode[] }
  /** A link to another note in the vault, resolved to a vault-relative path. */
  | { kind: 'doclink'; path: string; children: InlineNode[] };

/* ------------------------------------------------------------------ */
/* Blocks                                                              */
/* ------------------------------------------------------------------ */

export interface Span {
  /** 1-based, inclusive. Matches `MemoryChunk.startLine`. */
  startLine: number;
  /** 1-based, inclusive. Matches `MemoryChunk.endLine`. */
  endLine: number;
}

export interface ListItem {
  inline: InlineNode[];
  /** Indent level, 0-3. */
  depth: number;
  /** `null` when the item is not a task item. */
  checked: boolean | null;
  startLine: number;
}

export type Block = Span &
  (
    | { kind: 'frontmatter'; text: string }
    | { kind: 'heading'; level: number; inline: InlineNode[]; text: string }
    | { kind: 'paragraph'; inline: InlineNode[] }
    | {
        kind: 'list';
        ordered: boolean;
        start: number;
        items: ListItem[];
      }
    | {
        kind: 'code';
        language: string;
        code: string;
        /** The fence was never closed — the file is mid-edit or malformed. */
        unterminated: boolean;
      }
    | { kind: 'quote'; blocks: Block[] }
    | { kind: 'rule' }
    | { kind: 'truncated'; reason: string }
  );

export interface ParsedMarkdown {
  blocks: Block[];
  /** Total lines in the source, before any cap. */
  lineCount: number;
  /** True when a cap cut the document short. */
  truncated: boolean;
  /** Headings, in order — the preview's outline. */
  outline: { level: number; text: string; line: number }[];
}

/* ------------------------------------------------------------------ */
/* URL safety                                                          */
/* ------------------------------------------------------------------ */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto']);

/**
 * The one function standing between a note and the OS browser.
 *
 * Main's `setWindowOpenHandler` hands every `target="_blank"` URL straight to
 * `shell.openExternal` without inspecting it, so this whitelist is the only
 * check in the path. Returns `null` for anything that is not plainly an
 * external web or mail address — including relative links, which
 * {@link resolveDocLink} handles separately.
 */
export function safeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  // A newline or a NUL inside a URL is always an attempt to smuggle something
  // past a scheme check.
  if (CONTROL_CHARS.test(trimmed)) return null;
  const match = SCHEME.exec(trimmed);
  if (!match) return null;
  return ALLOWED_SCHEMES.has(match[1].toLowerCase()) ? trimmed : null;
}

/**
 * Resolve a relative Markdown link against the doc that contains it.
 *
 * `./meetings/2026.md` from `people/ana.md` is `people/meetings/2026.md`. A
 * link that climbs out of the vault, or points at something that is not a
 * `.md` file, returns `null` and renders as plain text.
 */
export function resolveDocLink(
  href: string,
  fromPath: string,
): string | null {
  const target = href.trim().split('#')[0].split('?')[0];
  if (!target || CONTROL_CHARS.test(target)) return null;
  if (SCHEME.test(target)) return null;
  if (!/\.mdx?$/i.test(target)) return null;

  const base = target.startsWith('/')
    ? []
    : fromPath.split('/').slice(0, -1).filter(Boolean);
  const out = [...base];
  for (const part of target.replace(/^\//, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null; // escapes the vault
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.length > 0 ? out.join('/') : null;
}

/* ------------------------------------------------------------------ */
/* Inline parsing                                                      */
/* ------------------------------------------------------------------ */

const PUNCTUATION = new Set([
  ...'\\`*_{}[]()#+-.!<>~|"\'',
] as readonly string[]);

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

function runLength(src: string, from: number, ch: string, max: number): number {
  let n = 0;
  while (n < max && src[from + n] === ch) n += 1;
  return n;
}

interface InlineContext {
  /** Vault path of the containing doc, for relative link resolution. */
  fromPath: string;
  /**
   * Delimiters already proven to have no further occurrence. Once
   * `indexOf(d, i)` returns -1 it returns -1 for every larger `i` too, so one
   * failed scan settles the question for the rest of the string. This is what
   * keeps a pathological line linear instead of quadratic.
   */
  missing: Set<string>;
}

function findClosing(
  src: string,
  from: number,
  needle: string,
  ctx: InlineContext,
): number {
  if (ctx.missing.has(needle)) return -1;
  const at = src.indexOf(needle, from);
  if (at === -1) ctx.missing.add(needle);
  return at;
}

/** Longest link target we will scan for a closing paren. */
const MAX_LINK_TARGET = 2048;

/**
 * Index of the `)` that closes a link target, counting nested parens.
 *
 * `[x](javascript:alert(1))` has to be read as one target, not truncated at the
 * inner paren — otherwise the mangled remainder leaks into the rendered text.
 * Bounded scan, so a document full of unclosed `](` costs a constant per
 * occurrence.
 */
function findLinkEnd(source: string, from: number): number {
  const limit = Math.min(source.length, from + MAX_LINK_TARGET);
  let depth = 0;
  for (let i = from; i < limit; i += 1) {
    const ch = source[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/**
 * Turn one run of text into inline nodes.
 *
 * Single pass, left to right. Anything that does not close is kept as the
 * literal characters that were typed, which is both the CommonMark behaviour
 * and the safe one.
 */
export function parseInline(
  source: string,
  fromPath = '',
  depth = 0,
): InlineNode[] {
  if (
    source.length === 0 ||
    source.length > MAX_INLINE_CHARS ||
    depth > MAX_INLINE_DEPTH
  ) {
    return source ? [{ kind: 'text', value: source }] : [];
  }

  const ctx: InlineContext = { fromPath, missing: new Set() };
  const nodes: InlineNode[] = [];
  let buffer = '';
  let i = 0;

  const flush = (): void => {
    if (buffer) {
      nodes.push({ kind: 'text', value: buffer });
      buffer = '';
    }
  };

  while (i < source.length) {
    const ch = source[i];

    // Backslash escape: the next punctuation character is literal.
    if (ch === '\\' && PUNCTUATION.has(source[i + 1] ?? '')) {
      buffer += source[i + 1];
      i += 2;
      continue;
    }

    // Code span. Longest-run-wins, so ``a ` b`` works.
    if (ch === '`') {
      const run = runLength(source, i, '`', 8);
      const fence = '`'.repeat(run);
      const close = findClosing(source, i + run, fence, ctx);
      if (close !== -1) {
        flush();
        nodes.push({
          kind: 'code',
          value: source.slice(i + run, close).replace(/^ | $/g, ''),
        });
        i = close + run;
        continue;
      }
      buffer += fence;
      i += run;
      continue;
    }

    // Strong / emphasis / strikethrough.
    if (ch === '*' || ch === '_' || ch === '~') {
      const run = runLength(source, i, ch, 2);
      const wide = run >= 2;
      // `~` only ever means strikethrough, and only doubled.
      const usable = ch === '~' ? wide : true;
      // `snake_case_names` must not become emphasis mid-word.
      const intraWord = ch === '_' && isWordChar(source[i - 1]);
      if (usable && !intraWord) {
        const delim = ch.repeat(wide ? 2 : 1);
        const close = findClosing(source, i + delim.length, delim, ctx);
        const closesWord =
          ch === '_' && close !== -1
            ? isWordChar(source[close + delim.length])
            : false;
        if (close !== -1 && close > i + delim.length && !closesWord) {
          const inner = source.slice(i + delim.length, close);
          flush();
          const children = parseInline(inner, fromPath, depth + 1);
          if (ch === '~') nodes.push({ kind: 'strike', children });
          else if (wide) nodes.push({ kind: 'strong', children });
          else nodes.push({ kind: 'em', children });
          i = close + delim.length;
          continue;
        }
      }
      buffer += ch.repeat(run);
      i += run;
      continue;
    }

    // Inline link: [label](target)
    if (ch === '[') {
      const labelEnd = findClosing(source, i + 1, '](', ctx);
      const targetEnd = labelEnd === -1 ? -1 : findLinkEnd(source, labelEnd + 2);
      if (labelEnd !== -1 && targetEnd !== -1) {
        const label = source.slice(i + 1, labelEnd);
        // A Markdown title (`(url "title")`) is dropped, not rendered.
        const target = source.slice(labelEnd + 2, targetEnd).split(/\s+/)[0];
        const href = safeHref(target);
        const doc = href ? null : resolveDocLink(target, fromPath);
        if (href || doc) {
          flush();
          const children = parseInline(label, fromPath, depth + 1);
          const text = children.length > 0 ? children : [
            { kind: 'text' as const, value: target },
          ];
          nodes.push(
            href
              ? { kind: 'link', href, children: text }
              : { kind: 'doclink', path: doc as string, children: text },
          );
          i = targetEnd + 1;
          continue;
        }
        // Rejected scheme. Keep the label, drop the link — showing the target
        // as clickable-looking text would be the whole trick.
        flush();
        nodes.push(...parseInline(label, fromPath, depth + 1));
        i = targetEnd + 1;
        continue;
      }
      buffer += ch;
      i += 1;
      continue;
    }

    // Autolink: <https://example.com>
    if (ch === '<') {
      const close = findClosing(source, i + 1, '>', ctx);
      if (close !== -1) {
        const inner = source.slice(i + 1, close);
        const href = safeHref(inner);
        if (href) {
          flush();
          nodes.push({
            kind: 'link',
            href,
            children: [{ kind: 'text', value: inner }],
          });
          i = close + 1;
          continue;
        }
      }
      // Everything else starting with `<` — including `<script>` — is text.
      buffer += ch;
      i += 1;
      continue;
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return nodes;
}

/** Flatten inline nodes back to plain text — for titles and aria labels. */
export function inlineText(nodes: InlineNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text' || node.kind === 'code') out += node.value;
    else out += inlineText(node.children);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Block parsing                                                       */
/* ------------------------------------------------------------------ */

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/;
const RULE_RE = /^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
const BULLET_RE = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS
    ? `${line.slice(0, MAX_LINE_CHARS)} …`
    : line;
}

function isBlockStart(line: string): boolean {
  return (
    line.trim() === '' ||
    HEADING_RE.test(line) ||
    FENCE_RE.test(line) ||
    RULE_RE.test(line) ||
    BULLET_RE.test(line) ||
    ORDERED_RE.test(line) ||
    QUOTE_RE.test(line)
  );
}

interface Cursor {
  lines: string[];
  /** 0-based index into `lines`. */
  at: number;
  /** Line number of `lines[0]` in the original file, 1-based. */
  offset: number;
}

/** 1-based line number of the cursor's current position. */
function lineNo(cursor: Cursor, index = cursor.at): number {
  return cursor.offset + index;
}

function parseFrontmatter(cursor: Cursor): Block | null {
  if (cursor.at !== 0 || cursor.lines[0]?.trim() !== '---') return null;
  for (let i = 1; i < cursor.lines.length; i += 1) {
    const trimmed = cursor.lines[i].trim();
    if (trimmed === '---' || trimmed === '...') {
      const block: Block = {
        kind: 'frontmatter',
        text: cursor.lines.slice(1, i).map(clip).join('\n'),
        startLine: lineNo(cursor, 1),
        endLine: lineNo(cursor, i + 1),
      };
      cursor.at = i + 1;
      return block;
    }
  }
  return null;
}

function parseFence(cursor: Cursor): Block | null {
  const line = cursor.lines[cursor.at];
  const match = FENCE_RE.exec(line);
  if (!match) return null;

  const fence = match[1];
  const marker = fence[0];
  const language = match[2].trim().split(/\s+/)[0] ?? '';
  const startLine = lineNo(cursor);
  const body: string[] = [];

  let i = cursor.at + 1;
  let closed = false;
  while (i < cursor.lines.length) {
    const candidate = cursor.lines[i].trim();
    if (
      candidate.startsWith(marker.repeat(3)) &&
      candidate === marker.repeat(candidate.length) &&
      candidate.length >= fence.length
    ) {
      closed = true;
      break;
    }
    body.push(clip(cursor.lines[i]));
    i += 1;
  }

  cursor.at = closed ? i + 1 : i;
  return {
    kind: 'code',
    language: /^[\w+#.-]{0,20}$/.test(language) ? language : '',
    code: body.join('\n'),
    unterminated: !closed,
    startLine,
    endLine: lineNo(cursor, closed ? i : i - 1),
  };
}

function parseList(cursor: Cursor, fromPath: string): Block | null {
  const first =
    BULLET_RE.exec(cursor.lines[cursor.at]) ??
    ORDERED_RE.exec(cursor.lines[cursor.at]);
  if (!first) return null;

  const ordered = ORDERED_RE.test(cursor.lines[cursor.at]);
  const start = ordered ? Number.parseInt(first[2], 10) : 1;
  const items: ListItem[] = [];
  const startLine = lineNo(cursor);
  let i = cursor.at;

  while (i < cursor.lines.length) {
    const line = cursor.lines[i];
    const match = ordered ? ORDERED_RE.exec(line) : BULLET_RE.exec(line);
    if (match) {
      const task = TASK_RE.exec(match[3]);
      items.push({
        depth: Math.min(3, Math.floor(match[1].replace(/\t/g, '  ').length / 2)),
        checked: task ? task[1].toLowerCase() === 'x' : null,
        inline: parseInline(clip(task ? task[2] : match[3]), fromPath),
        startLine: lineNo(cursor, i),
      });
      i += 1;
      continue;
    }
    // A plain indented line continues the previous item.
    if (items.length > 0 && /^\s+\S/.test(line)) {
      const previous = items[items.length - 1];
      previous.inline = [
        ...previous.inline,
        { kind: 'text', value: ' ' },
        ...parseInline(clip(line.trim()), fromPath),
      ];
      i += 1;
      continue;
    }
    break;
  }

  cursor.at = i;
  return {
    kind: 'list',
    ordered,
    start,
    items,
    startLine,
    endLine: lineNo(cursor, i - 1),
  };
}

function parseQuote(
  cursor: Cursor,
  fromPath: string,
  depth: number,
): Block | null {
  if (!QUOTE_RE.test(cursor.lines[cursor.at])) return null;
  const startLine = lineNo(cursor);
  const inner: string[] = [];
  let i = cursor.at;
  while (i < cursor.lines.length) {
    const match = QUOTE_RE.exec(cursor.lines[i]);
    if (!match) break;
    inner.push(match[1]);
    i += 1;
  }
  cursor.at = i;
  const endLine = lineNo(cursor, i - 1);
  return {
    kind: 'quote',
    blocks:
      depth >= MAX_QUOTE_DEPTH
        ? [
            {
              kind: 'paragraph',
              inline: parseInline(inner.map(clip).join(' '), fromPath),
              startLine,
              endLine,
            },
          ]
        : parseLines(inner, startLine, fromPath, depth + 1).blocks,
    startLine,
    endLine,
  };
}

function parseLines(
  lines: string[],
  offset: number,
  fromPath: string,
  depth: number,
): { blocks: Block[]; truncated: boolean } {
  const cursor: Cursor = { lines, at: 0, offset };
  const blocks: Block[] = [];
  let truncated = false;

  const front = parseFrontmatter(cursor);
  if (front) blocks.push(front);

  while (cursor.at < lines.length) {
    if (blocks.length >= MAX_BLOCKS) {
      truncated = true;
      break;
    }

    const line = lines[cursor.at];

    if (line.trim() === '') {
      cursor.at += 1;
      continue;
    }

    const fenced = parseFence(cursor);
    if (fenced) {
      blocks.push(fenced);
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const text = heading[2].replace(/\s+#+\s*$/, '').trim();
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        inline: parseInline(clip(text), fromPath),
        text,
        startLine: lineNo(cursor),
        endLine: lineNo(cursor),
      });
      cursor.at += 1;
      continue;
    }

    if (RULE_RE.test(line)) {
      blocks.push({
        kind: 'rule',
        startLine: lineNo(cursor),
        endLine: lineNo(cursor),
      });
      cursor.at += 1;
      continue;
    }

    const quote = parseQuote(cursor, fromPath, depth);
    if (quote) {
      blocks.push(quote);
      continue;
    }

    const list = parseList(cursor, fromPath);
    if (list) {
      blocks.push(list);
      continue;
    }

    // Paragraph: everything up to a blank line or the start of another block.
    const startLine = lineNo(cursor);
    const paragraph: string[] = [clip(line)];
    let i = cursor.at + 1;
    while (i < lines.length && !isBlockStart(lines[i])) {
      paragraph.push(clip(lines[i]));
      i += 1;
    }
    cursor.at = i;
    blocks.push({
      kind: 'paragraph',
      inline: parseInline(paragraph.join('\n'), fromPath),
      startLine,
      endLine: offset + i - 1,
    });
  }

  return { blocks, truncated };
}

/**
 * Parse a document.
 *
 * `fromPath` is the doc's vault-relative path; it is only used to resolve
 * relative links to other notes.
 */
export function parseMarkdown(
  source: string,
  fromPath = '',
): ParsedMarkdown {
  const allLines = source.split('\n');
  const capped = allLines.length > MAX_LINES;
  const lines = capped ? allLines.slice(0, MAX_LINES) : allLines;

  const { blocks, truncated } = parseLines(lines, 1, fromPath, 0);

  if (capped || truncated) {
    const shown = blocks[blocks.length - 1]?.endLine ?? 0;
    blocks.push({
      kind: 'truncated',
      reason: capped
        ? `Showing the first ${MAX_LINES.toLocaleString()} of ${allLines.length.toLocaleString()} lines. Switch to Raw for the whole file.`
        : 'This document is larger than the preview renders. Switch to Raw for the whole file.',
      startLine: shown + 1,
      endLine: allLines.length,
    });
  }

  const outline = blocks
    .filter((block): block is Block & { kind: 'heading' } =>
      block.kind === 'heading',
    )
    .map((block) => ({
      level: block.level,
      text: block.text,
      line: block.startLine,
    }));

  return {
    blocks,
    lineCount: allLines.length,
    truncated: capped || truncated,
    outline,
  };
}

/* ------------------------------------------------------------------ */
/* Search snippets                                                     */
/* ------------------------------------------------------------------ */

/** FTS4 wraps matched terms in these. See `main/modules/memory/store.ts`. */
export const SNIPPET_OPEN = '\u2039';
export const SNIPPET_CLOSE = '\u203a';

export interface SnippetPart {
  text: string;
  match: boolean;
}

/**
 * Split a `snippet()` result into matched and unmatched runs.
 *
 * The markers are plain text and the result is plain text — the point of
 * returning parts rather than markup is that the caller renders `<mark>`
 * elements itself and nothing ever gets interpreted.
 */
export function splitSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let rest = snippet;
  let guard = 0;

  while (rest.length > 0 && guard < 400) {
    guard += 1;
    const open = rest.indexOf(SNIPPET_OPEN);
    if (open === -1) break;
    const close = rest.indexOf(SNIPPET_CLOSE, open + 1);
    if (close === -1) break;
    if (open > 0) parts.push({ text: rest.slice(0, open), match: false });
    parts.push({ text: rest.slice(open + 1, close), match: true });
    rest = rest.slice(close + 1);
  }

  if (rest.length > 0) parts.push({ text: rest, match: false });
  return parts.filter((part) => part.text.length > 0);
}
