/**
 * The openhumanz home output protocol — parser + node types.
 *
 * On the home surface, Claude wraps ONLY user-facing output in namespaced
 * bracket tags; everything else it writes is background narration that must NOT
 * appear in the home UI. This parses an assistant turn's raw text into the small
 * set of renderable nodes (say / ask / card), dropping every untagged span.
 *
 * The namespace (`openhumanz-`) means tags never collide with HTML, markdown,
 * code, or message content the user might be sending.
 *
 * Streaming-safe: a node is only produced once its closing bracket has arrived.
 * A partial tag at the end of the (still-streaming) text yields nothing until it
 * completes — so no half-parsed garbage flashes on screen.
 *
 * Grammar:
 *   paired:        [openhumanz-say]…text…[/openhumanz-say]
 *                  [openhumanz-ask]…text…[/openhumanz-ask]
 *   self-closing:  [openhumanz-card/<type> key="value" …/]
 */

export type TagNode =
  | { kind: 'say'; text: string }
  | { kind: 'ask'; text: string }
  | { kind: 'card'; cardType: string; attrs: Record<string, string> };

/** Parse `key="value"` attribute pairs, honoring \" escapes inside values. */
export function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w-]+)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null = re.exec(raw);
  while (m !== null) {
    const value = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    attrs[m[1]] = value;
    m = re.exec(raw);
  }
  return attrs;
}

// One combined pattern, scanned left-to-right, so nodes come out in source
// order and each match's real position is known. Groups:
//   1 = paired tag name (say|ask), 2 = its inner text
//   3 = card type,                  4 = its raw attributes
const NODE_RE =
  /\[openhumanz-(say|ask)\]([\s\S]*?)\[\/openhumanz-\1\]|\[openhumanz-card\/([\w-]+)((?:[^[\]]|\\.)*?)\/\]/g;

/**
 * Parse raw assistant text into renderable tag nodes, in the order they appear.
 * Untagged text is dropped. Only COMPLETE tags (closing bracket present) are
 * emitted, so this is safe to call on partial streaming text every render.
 */
export function parseTags(text: string): TagNode[] {
  const nodes: TagNode[] = [];
  NODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null = NODE_RE.exec(text);
  while (m !== null) {
    if (m[1]) {
      const inner = m[2].trim();
      if (inner) nodes.push({ kind: m[1] as 'say' | 'ask', text: inner });
    } else if (m[3]) {
      nodes.push({
        kind: 'card',
        cardType: m[3],
        attrs: parseAttrs(m[4] ?? ''),
      });
    }
    m = NODE_RE.exec(text);
  }
  return nodes;
}

/** True when the text contains at least one complete openhumanz tag. */
export function hasTags(text: string): boolean {
  return parseTags(text).length > 0;
}
