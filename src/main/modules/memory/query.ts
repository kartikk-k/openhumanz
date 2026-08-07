/**
 * FTS4 query building and ranking.
 *
 * Two jobs, both consequences of the same verified fact: **sql.js has no FTS5**
 * (`USING fts5` → `no such module: fts5`, and `OMIT_LOAD_EXTENSION` rules out
 * loading it at runtime). FTS4 is what we have.
 *
 * 1. **Query building.** A search string arrives from an agent that may have
 *    just read a hostile email, and FTS4 raises `malformed MATCH expression` for
 *    plenty of innocent-looking input (`"unbalanced`, `foo NEAR`, `(((`, `a OR`).
 *    So the query is never passed through. It is tokenised here and a new
 *    expression is *built* from a whitelist — bare terms, optional trailing `*`,
 *    and quoted phrases — which is then bound as a parameter. The output can
 *    contain nothing the tokeniser did not produce, so neither SQL injection nor
 *    an FTS syntax error is reachable from user input.
 *
 * 2. **Ranking.** FTS4 has no `bm25()` and no `rank` column. `matchinfo()`
 *    returns the raw statistics as a blob and we compute BM25 in JS. Format
 *    `pcnxal` was verified against the shipped sql.js build and lays out as
 *    `[p, c, n, x(3*p*c), a(c), l(c)]`.
 */

/* ------------------------------------------------------------------ */
/* Query building                                                      */
/* ------------------------------------------------------------------ */

/** Beyond this a query is padding, and every extra phrase costs a scan. */
export const MAX_TERMS = 16;
/** Longest single token kept. Longer ones are truncated, not dropped. */
export const MAX_TERM_CHARS = 64;

/** Only these ever reach SQLite. Everything else is discarded. */
const TERM_RE = /[\p{L}\p{N}_]+/gu;
const PHRASE_RE = /"([^"]*)"/g;

/**
 * FTS3/4 treats these as operators, but only in upper case.
 *
 * A user searching `flights NEAR paris` or an injection probe reading
 * `" OR 1=1 --` both tokenise to a bare keyword, and a keyword in a term
 * position is `malformed MATCH expression`. Lower-casing turns them back into
 * ordinary words — the `unicode61` tokeniser folds case at index time, so the
 * search still matches the text — which keeps recall that dropping them would
 * throw away.
 */
const FTS_KEYWORD_RE = /^(AND|OR|NOT|NEAR)$/;

function defuseKeyword(token: string): string {
  return FTS_KEYWORD_RE.test(token) ? token.toLowerCase() : token;
}

export interface BuiltQuery {
  /** The expression to bind to `MATCH`. */
  expression: string;
  /** The whitelisted tokens it was built from, for logging and diagnostics. */
  terms: string[];
}

function tokenize(input: string): string[] {
  const out: string[] = [];
  const matches = input.matchAll(TERM_RE);
  for (const match of matches) {
    const token = defuseKeyword(match[0].slice(0, MAX_TERM_CHARS));
    if (token) out.push(token);
  }
  return out;
}

/**
 * Build a safe FTS4 `MATCH` expression, or `null` when the input contains no
 * searchable token at all (`"';--"`, emoji, punctuation). A `null` return means
 * "no results", not "error" — a search must never throw at the caller.
 *
 * `operator` joins the terms. Callers try `AND` first and fall back to `OR`,
 * which is a cheap way to get precision when it is available and recall when it
 * is not.
 */
export function buildFtsQuery(
  raw: string,
  operator: 'AND' | 'OR' = 'AND',
): BuiltQuery | null {
  const parts: string[] = [];
  const terms: string[] = [];
  const seen = new Set<string>();

  const push = (expression: string, token: string): void => {
    const key = expression.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(expression);
    terms.push(token);
  };

  // Quoted phrases first, then the leftovers as bare terms.
  let remainder = raw;
  const phrases = [...raw.matchAll(PHRASE_RE)];
  if (phrases.length > 0) {
    remainder = raw.replace(PHRASE_RE, ' ');
    for (const phrase of phrases) {
      const words = tokenize(phrase[1]).slice(0, MAX_TERMS);
      if (words.length === 0) continue;
      if (words.length === 1) push(words[0], words[0]);
      else push(`"${words.join(' ')}"`, words.join(' '));
      if (parts.length >= MAX_TERMS) break;
    }
  }

  for (const match of remainder.matchAll(TERM_RE)) {
    if (parts.length >= MAX_TERMS) break;
    const token = defuseKeyword(match[0].slice(0, MAX_TERM_CHARS));
    if (!token) continue;
    // An explicit trailing `*` in the input is honoured as a prefix search.
    // `match.index` is always defined for a non-global-flag-reset matchAll.
    const after = remainder[(match.index ?? 0) + match[0].length];
    push(after === '*' ? `${token}*` : token, token);
  }

  if (parts.length === 0) return null;
  return { expression: parts.join(` ${operator} `), terms };
}

/* ------------------------------------------------------------------ */
/* matchinfo                                                           */
/* ------------------------------------------------------------------ */

/**
 * Verified against the shipped sql.js build (SQLite 3.49.1, `ENABLE_FTS3` +
 * `ENABLE_FTS3_PARENTHESIS`). Values appear in the order the format characters
 * do: phrase count, column count, total rows, the per-phrase/column triples,
 * average column lengths, this row's column lengths.
 */
export const MATCHINFO_FORMAT = 'pcnxal';

export interface MatchInfo {
  /** Number of phrases in the query. */
  phrases: number;
  /** Number of columns in the FTS table. */
  columns: number;
  /** Rows in the FTS table. */
  rows: number;
  /** `[phrase][column]` → hits in this row, hits overall, docs containing. */
  hits: { inRow: number; inCollection: number; docs: number }[][];
  /** Average token count per column, across the table. */
  averageLength: number[];
  /** Token count per column, for this row. */
  length: number[];
}

/** Decode a `matchinfo(tbl, 'pcnxal')` blob. Returns null if it is malformed. */
export function decodeMatchinfo(blob: unknown): MatchInfo | null {
  if (!(blob instanceof Uint8Array) || blob.byteLength < 12) return null;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const total = Math.floor(blob.byteLength / 4);
  const at = (index: number): number =>
    index < total ? view.getUint32(index * 4, true) : 0;

  const phrases = at(0);
  const columns = at(1);
  const rows = at(2);
  if (phrases === 0 || columns === 0) return null;
  if (total < 3 + 3 * phrases * columns + 2 * columns) return null;

  const hits: MatchInfo['hits'] = [];
  let cursor = 3;
  for (let p = 0; p < phrases; p += 1) {
    const row: MatchInfo['hits'][number] = [];
    for (let c = 0; c < columns; c += 1) {
      row.push({
        inRow: at(cursor),
        inCollection: at(cursor + 1),
        docs: at(cursor + 2),
      });
      cursor += 3;
    }
    hits.push(row);
  }

  const averageLength: number[] = [];
  for (let c = 0; c < columns; c += 1, cursor += 1) averageLength.push(at(cursor));
  const length: number[] = [];
  for (let c = 0; c < columns; c += 1, cursor += 1) length.push(at(cursor));

  return { phrases, columns, rows, hits, averageLength, length };
}

export interface Bm25Options {
  /** Per-column multiplier. Missing entries default to 1. */
  weights?: number[];
  /** Term-frequency saturation. */
  k1?: number;
  /** Length-normalisation strength. */
  b?: number;
}

/**
 * Okapi BM25, computed in JS because FTS4 has no `bm25()`.
 *
 * Higher is better. Absolute values are meaningless across queries; only the
 * ordering within one result set is.
 */
export function bm25(info: MatchInfo, options: Bm25Options = {}): number {
  const { weights = [], k1 = 1.2, b = 0.75 } = options;
  const total = Math.max(1, info.rows);
  let score = 0;

  for (let p = 0; p < info.phrases; p += 1) {
    for (let c = 0; c < info.columns; c += 1) {
      const cell = info.hits[p][c];
      if (cell.inRow === 0) continue;

      const docs = Math.max(1, Math.min(cell.docs, total));
      // +1 inside the log keeps the idf non-negative for a term present in
      // every row, which would otherwise score matches below non-matches.
      const idf = Math.log(1 + (total - docs + 0.5) / (docs + 0.5));

      const average = info.averageLength[c] || 1;
      const length = info.length[c] || average;
      const norm =
        (cell.inRow * (k1 + 1)) /
        (cell.inRow + k1 * (1 - b + (b * length) / average));

      score += (weights[c] ?? 1) * idf * norm;
    }
  }

  return score;
}
