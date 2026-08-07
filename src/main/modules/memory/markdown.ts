/**
 * Markdown parsing and chunking.
 *
 * The vault is Markdown files a human owns. Nothing here rewrites a file; this
 * module only reads one and describes it — front matter, title, tags, and a
 * deterministic list of chunks.
 *
 * **Determinism is the contract.** The same bytes must always produce the same
 * chunk boundaries and the same normalised text, because a chunk's identity is
 * a hash of that text. If chunking ever became non-deterministic, re-indexing
 * an unchanged file would duplicate every row in the index.
 *
 * The splitter is deliberately dull: sections at headings, paragraphs at blank
 * lines, packed up to a character budget, fenced code kept whole. No embeddings,
 * no sealing cascade, no topic tree. Flat search has to demonstrably fail before
 * any of that is justified.
 */
import path from 'node:path';
import type { JsonObject } from '../../../shared/common';

/** Character budget for one chunk. Prose paragraphs pack until they exceed it. */
export const DEFAULT_MAX_CHUNK_CHARS = 1200;

/** A block longer than this on its own is hard-split at line boundaries. */
export const DEFAULT_HARD_SPLIT_CHARS = 1600;

/** How much of the body goes into {@link ParsedDoc.excerpt}. */
export const EXCERPT_CHARS = 200;

export interface ParsedDoc {
  /** Parsed YAML front matter (a small subset — see {@link parseFrontmatter}). */
  frontmatter: JsonObject;
  /** Front matter `title`, else the first H1, else the file name without `.md`. */
  title: string;
  /** Front matter `tags`, normalised to lowercase and de-duplicated. */
  tags: string[];
  /** The document minus its front matter. */
  body: string;
  /** 1-based line in the *file* at which {@link body} starts. */
  bodyStartLine: number;
  /** First {@link EXCERPT_CHARS} characters of readable body text. */
  excerpt: string;
}

export interface RawChunk {
  /** Heading breadcrumb, e.g. `People > Ana > Preferences`. Empty at top level. */
  heading: string;
  text: string;
  /** 1-based, inclusive, in the file. */
  startLine: number;
  /** 1-based, inclusive, in the file. */
  endLine: number;
  ordinal: number;
}

const FRONTMATTER_OPEN = /^---\s*$/;
const FRONTMATTER_CLOSE = /^(---|\.\.\.)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s{0,3}(```|~~~)/;

/* ------------------------------------------------------------------ */
/* Front matter                                                        */
/* ------------------------------------------------------------------ */

function coerceScalar(raw: string): unknown {
  const value = raw.trim();
  if (value === '') return '';
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d*\.\d+$/.test(value)) return Number.parseFloat(value);
  return value;
}

function parseInlineList(raw: string): unknown[] {
  const inner = raw.trim().slice(1, -1);
  if (!inner.trim()) return [];
  return inner.split(',').map((part) => coerceScalar(part));
}

/**
 * A deliberately small YAML subset: `key: scalar`, `key: [a, b]`, and a `key:`
 * followed by indented `- item` lines. That is what memory front matter
 * actually contains, and it avoids a YAML dependency for a five-line header.
 * Anything it does not understand is ignored rather than throwing — a note with
 * an odd header must still be indexed.
 */
export function parseFrontmatter(lines: string[]): JsonObject {
  const out: JsonObject = {};
  let pendingKey: string | null = null;
  let pendingList: unknown[] | null = null;

  const flush = (): void => {
    if (pendingKey !== null && pendingList !== null)
      out[pendingKey] = pendingList;
    pendingKey = null;
    pendingList = null;
  };

  for (const line of lines) {
    if (!line.trim()) continue;

    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && pendingKey !== null) {
      if (!pendingList) pendingList = [];
      pendingList.push(coerceScalar(listItem[1]));
      continue;
    }

    const pair = /^([A-Za-z0-9_.$-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    flush();

    const key = pair[1];
    const value = pair[2];
    if (value === '') {
      pendingKey = key;
      pendingList = null;
      continue;
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      out[key] = parseInlineList(value);
      continue;
    }
    out[key] = coerceScalar(value);
  }
  flush();
  return out;
}

function toTagList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(/[,\s]+/);
  return [];
}

function normalizeTags(value: unknown): string[] {
  const raw = toTagList(value);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' && typeof entry !== 'number') continue;
    const tag = String(entry).trim().replace(/^#/, '').toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/** Strip the markup that would otherwise dominate a 200-character preview. */
function toPlainText(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split a raw file into front matter plus body.
 *
 * `filePath` is only used for the title fallback, so a note with no heading and
 * no front matter still shows something useful in the browser.
 */
export function parseMarkdown(filePath: string, raw: string): ParsedDoc {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = withoutBom.split('\n');

  let frontmatter: JsonObject = {};
  let bodyStartIndex = 0;

  if (lines.length > 0 && FRONTMATTER_OPEN.test(lines[0])) {
    for (let i = 1; i < lines.length; i += 1) {
      if (FRONTMATTER_CLOSE.test(lines[i])) {
        frontmatter = parseFrontmatter(lines.slice(1, i));
        bodyStartIndex = i + 1;
        break;
      }
    }
  }

  const body = lines.slice(bodyStartIndex).join('\n');

  let title = '';
  const fmTitle = frontmatter.title;
  if (typeof fmTitle === 'string' && fmTitle.trim()) {
    title = fmTitle.trim();
  } else {
    for (const line of lines.slice(bodyStartIndex)) {
      const heading = HEADING_RE.exec(line);
      if (heading && heading[1].length === 1 && heading[2].trim()) {
        title = heading[2].trim();
        break;
      }
    }
  }
  if (!title) title = path.basename(filePath).replace(/\.md$/i, '');

  return {
    frontmatter,
    title,
    tags: normalizeTags(frontmatter.tags ?? frontmatter.tag),
    body,
    bodyStartLine: bodyStartIndex + 1,
    excerpt: toPlainText(body).slice(0, EXCERPT_CHARS),
  };
}

/* ------------------------------------------------------------------ */
/* Chunking                                                            */
/* ------------------------------------------------------------------ */

interface NumberedLine {
  text: string;
  /** 1-based line number in the file. */
  line: number;
}

interface Block {
  heading: string;
  lines: NumberedLine[];
  chars: number;
}

/** `#`-level breadcrumb from the current heading stack. */
function breadcrumb(stack: (string | null)[]): string {
  return stack.filter((part): part is string => Boolean(part)).join(' > ');
}

/**
 * Blocks: paragraph-sized runs of lines, never crossing a heading and never
 * splitting a fenced code block.
 */
function toBlocks(parsed: ParsedDoc): Block[] {
  const lines = parsed.body.split('\n');
  const blocks: Block[] = [];
  const stack: (string | null)[] = [null, null, null, null, null, null];

  let heading = '';
  let current: NumberedLine[] = [];
  let fence: string | null = null;

  const flush = (): void => {
    if (current.some((entry) => entry.text.trim())) {
      const text = current.map((entry) => entry.text).join('\n');
      blocks.push({ heading, lines: current, chars: text.length });
    }
    current = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    const line = parsed.bodyStartLine + i;

    const fenceMatch = FENCE_RE.exec(text);
    if (fenceMatch) {
      if (fence === null) {
        fence = fenceMatch[1];
        current.push({ text, line });
        continue;
      }
      if (text.trimStart().startsWith(fence)) {
        current.push({ text, line });
        fence = null;
        continue;
      }
    }

    if (fence !== null) {
      current.push({ text, line });
      continue;
    }

    const headingMatch = HEADING_RE.exec(text);
    if (headingMatch) {
      flush();
      const level = headingMatch[1].length;
      stack[level - 1] = headingMatch[2].trim() || null;
      for (let deeper = level; deeper < stack.length; deeper += 1) {
        stack[deeper] = null;
      }
      heading = breadcrumb(stack);
      continue;
    }

    if (!text.trim()) {
      flush();
      continue;
    }

    current.push({ text, line });
  }

  flush();
  return blocks;
}

/** Split an oversized block at line boundaries, never mid-line. */
function hardSplit(block: Block, maxChars: number): Block[] {
  if (block.chars <= maxChars) return [block];
  const out: Block[] = [];
  let bucket: NumberedLine[] = [];
  let chars = 0;
  for (const entry of block.lines) {
    const cost = entry.text.length + 1;
    if (bucket.length > 0 && chars + cost > maxChars) {
      out.push({ heading: block.heading, lines: bucket, chars });
      bucket = [];
      chars = 0;
    }
    bucket.push(entry);
    chars += cost;
  }
  if (bucket.length > 0) {
    out.push({ heading: block.heading, lines: bucket, chars });
  }
  return out;
}

export interface ChunkOptions {
  maxChars?: number;
  hardSplitChars?: number;
}

/**
 * Pack blocks into chunks.
 *
 * A chunk never spans two headings — the heading is the provenance breadcrumb
 * shown in the UI, and a chunk with two of them has no honest answer for what
 * it came from.
 */
export function chunkMarkdown(
  parsed: ParsedDoc,
  options: ChunkOptions = {},
): RawChunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const hardSplitChars = options.hardSplitChars ?? DEFAULT_HARD_SPLIT_CHARS;

  const blocks = toBlocks(parsed).flatMap((block) =>
    hardSplit(block, hardSplitChars),
  );

  const chunks: RawChunk[] = [];
  let pending: Block | null = null;

  const emit = (): void => {
    if (!pending) return;
    const kept = pending.lines;
    const text = kept
      .map((entry) => entry.text)
      .join('\n')
      .trim();
    if (text) {
      chunks.push({
        heading: pending.heading,
        text,
        startLine: kept[0].line,
        endLine: kept[kept.length - 1].line,
        ordinal: chunks.length,
      });
    }
    pending = null;
  };

  for (const block of blocks) {
    if (
      pending &&
      (pending.heading !== block.heading ||
        pending.chars + block.chars + 1 > maxChars)
    ) {
      emit();
    }
    if (!pending) {
      pending = {
        heading: block.heading,
        lines: [...block.lines],
        chars: block.chars,
      };
      continue;
    }
    // Blank separator line keeps paragraph boundaries readable in a snippet.
    pending.lines.push({ text: '', line: block.lines[0].line });
    pending.lines.push(...block.lines);
    pending.chars += block.chars + 1;
  }
  emit();

  return chunks;
}

/**
 * The exact bytes a chunk's identity is computed over.
 *
 * Whitespace is collapsed so that a reflowed paragraph, a converted line ending
 * or a trailing space does not mint a new chunk id and orphan the old row.
 */
export function normalizeChunkText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}
