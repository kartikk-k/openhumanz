/**
 * Settled-text helpers — shared by the components that render a chat turn's
 * text at its final ("settled") size and line layout, matching exactly where
 * AutoMergeText's streaming animation lands. Extracted so SettledQuestion,
 * SettledAnswer, and the live-transcript view all agree on the same sizing and
 * line-splitting rules (the source of several past wrap/snap bugs).
 */
import { SIZE_STYLES, layoutMergeText } from '../text/lib/partition-merge-text';
import { sizeForCount, wrapWords } from '../text/lib/timeline';

/** Column width the chat text lives in (viewport-driven, not fixed px). */
export const COLUMN_WIDTH = 'min(880px, 92vw)';

/** The size step AutoMergeText settles a fully-revealed text at. */
export function settledSize(text: string) {
  return sizeForCount(text.trim().split(/\s+/).filter(Boolean).length);
}

/** The font-size / line-height AutoMergeText settles a text at. */
export function settledFont(text: string) {
  const style = SIZE_STYLES[settledSize(text)];
  return { fontSize: style.fontSize, lineHeight: style.lineHeight };
}

/**
 * The EXACT committed lines AutoMergeText shows for a fully-revealed text, so a
 * settled layer that takes over is byte-identical:
 *  - 3xl/xl: layoutMergeText's forced short-line split.
 *  - base:   wrapWords' char-budget split (AutoMergeText's base path uses this,
 *            rendering each as its OWN centered line — NOT a natural pixel wrap).
 * Each returned line should be rendered nowrap (except base) so the browser
 * can't re-wrap it narrower than intended.
 */
export function settledLines(text: string) {
  if (settledSize(text) !== 'base') return layoutMergeText(text).lines;
  return wrapWords(text.trim().split(/\s+/).filter(Boolean)).map((line) =>
    line.join(' '),
  );
}

/** Whether a settled text's lines should be rendered nowrap (non-base sizes). */
export function settledNowrap(text: string): boolean {
  return settledSize(text) !== 'base';
}

/** Flatten a chat block list to plain text (text blocks only). */
export function blocksToText(
  blocks: { kind: string; text?: string }[],
): string {
  return blocks
    .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
