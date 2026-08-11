export const WORDS_PER_GROUP = 7;
export const FIRST_LINE_WORDS = 4;
export const MERGE_DURATION_MS = 360;

export function sizeStage(wordCount: number, wordsPerGroup = WORDS_PER_GROUP) {
  if (wordCount <= 0) return 0;
  if (wordCount <= wordsPerGroup) return 1;
  if (wordCount <= wordsPerGroup * 2) return 2;
  return 3;
}

export function crossesMerge(
  fromCount: number,
  toCount: number,
  wordsPerGroup = WORDS_PER_GROUP,
) {
  if (fromCount <= 0) return false;
  return (
    sizeStage(fromCount, wordsPerGroup) !== sizeStage(toCount, wordsPerGroup)
  );
}

export type TextSize = '3xl' | 'xl' | 'base';

export type MergeLayout = {
  size: TextSize;
  lines: string[];
};

// Size steps anchored to this project's largest streaming size (52px), then
// derived DOWN from there (the source prototype used 30/20/16; we keep the same
// falling shape but scaled so the top step matches our 52px hero size).
//   3xl = 52px  (largest — short answers / fresh questions)
//   xl  = 34px  (~0.65× — medium length)
//   base = 26px (~0.5×  — long answers, single wrapped block)
// linePx is the line-box height used for merge geometry; kept at ~1.35× font.
export const SIZE_STYLES: Record<
  TextSize,
  { fontSize: string; lineHeight: string; linePx: number }
> = {
  '3xl': { fontSize: '52px', lineHeight: '1.25', linePx: 65 },
  xl: { fontSize: '34px', lineHeight: '1.3', linePx: 44 },
  base: { fontSize: '26px', lineHeight: '1.4', linePx: 36 },
};

export function layoutMergeText(
  text: string,
  wordsPerGroup = WORDS_PER_GROUP,
): MergeLayout {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { size: '3xl', lines: [] };

  if (words.length <= wordsPerGroup) {
    if (words.length <= FIRST_LINE_WORDS) {
      return { size: '3xl', lines: [words.join(' ')] };
    }

    return {
      size: '3xl',
      lines: [
        words.slice(0, FIRST_LINE_WORDS).join(' '),
        words.slice(FIRST_LINE_WORDS).join(' '),
      ],
    };
  }

  if (words.length <= wordsPerGroup * 2) {
    return {
      size: 'xl',
      lines: [
        words.slice(0, wordsPerGroup).join(' '),
        words.slice(wordsPerGroup).join(' '),
      ],
    };
  }

  return {
    size: 'base',
    lines: [words.join(' ')],
  };
}

export function tokensFromLines(lines: string[]) {
  return lines.flatMap((line, lineIndex) => {
    const words = line.split(/\s+/).filter(Boolean);
    return words.map((word, wordIndex) => ({
      word,
      breakBefore: lineIndex > 0 && wordIndex === 0,
    }));
  });
}
