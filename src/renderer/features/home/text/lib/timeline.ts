import { crossesMerge, type TextSize } from './partition-merge-text';

/** Enter fade/blur length for a word or a line burst. */
export const WORD_ENTER_MS = 600;
/** Word-by-word until this many wrapped lines, then ramp toward line-by-line. */
export const LINE_SHIFT_AFTER = 5;
/** How many lines the word→line ramp spans at accelerate=1. */
export const LINE_RAMP_LINES = 4;
export const LINE_CHAR_BUDGET = 72;
export const LINE_DELAY_MS = 600;
export const ACCELERATE = 1;

function easeInOut(value: number) {
  return value < 0.5 ? 2 * value * value : 1 - (2 - 2 * value) ** 2 / 2;
}

function lerp(from: number, to: number, amount: number) {
  return from + (to - from) * amount;
}

export type EnterMode = 'word' | 'line';

export function wordDelay(_word: string, delayMs: number) {
  return delayMs;
}

export function sizeForCount(wordCount: number): TextSize {
  if (wordCount <= 7) return '3xl';
  if (wordCount <= 14) return 'xl';
  return 'base';
}

export function wrapWords(words: string[], maxChars = LINE_CHAR_BUDGET) {
  const lines: string[][] = [];
  let current: string[] = [];
  let length = 0;

  words.forEach((word) => {
    const extra = (current.length === 0 ? 0 : 1) + word.length;
    if (current.length > 0 && length + extra > maxChars) {
      lines.push(current);
      current = [word];
      length = word.length;
    } else {
      current.push(word);
      length += extra;
    }
  });

  if (current.length > 0) lines.push(current);
  return lines;
}

export function buildTimeline(
  words: string[],
  delayMs: number,
  mergePauseMs: number,
  lineDelayMs = LINE_DELAY_MS,
  accelerate = ACCELERATE,
) {
  const appearsAt: number[] = [];
  const enterMode: EnterMode[] = [];
  const lines = wrapWords(words);
  let time = 0;
  let index = 0;

  const emit = (mode: EnterMode, at: number) => {
    appearsAt[index] = at;
    enterMode[index] = mode;
    index += 1;
    if (crossesMerge(index - 1, index)) time += mergePauseMs;
  };

  lines.slice(0, LINE_SHIFT_AFTER).forEach((line) => {
    line.forEach(() => {
      time += delayMs;
      emit('word', time);
    });
  });

  const shiftAt = time;
  const restLines = lines.slice(LINE_SHIFT_AFTER);

  restLines.forEach((line, rampIndex) => {
    const amount = Math.min(
      1,
      ((rampIndex + 1) / LINE_RAMP_LINES) * accelerate,
    );
    const eased = easeInOut(amount);
    const chunkSize = Math.max(1, Math.round(lerp(1, line.length, eased)));
    const stepDelay = lerp(delayMs, lineDelayMs, eased);

    for (let offset = 0; offset < line.length; offset += chunkSize) {
      const count = Math.min(chunkSize, line.length - offset);
      time += stepDelay;
      const mode: EnterMode = count === 1 ? 'word' : 'line';
      for (let step = 0; step < count; step += 1) emit(mode, time);
    }
  });

  const duration = (appearsAt.at(-1) ?? 0) + WORD_ENTER_MS;

  return { appearsAt, enterMode, duration, shiftAt };
}

export type TimelineFrame = {
  text: string;
  visibleCount: number;
  wordProgress: number[];
  enterMode: EnterMode[];
  lastWordProgress: number;
  mergeProgress: number | null;
  sizeFrom: TextSize;
  sizeTo: TextSize;
  gear: EnterMode;
};

export function frameAt(
  time: number,
  words: string[],
  appearsAt: number[],
  mergeDurationMs: number,
  enterMode: EnterMode[] = [],
): TimelineFrame {
  let visibleCount = 0;
  for (let index = 0; index < words.length; index += 1) {
    if (time >= (appearsAt[index] ?? Infinity)) {
      visibleCount = index + 1;
    } else {
      break;
    }
  }

  const wordProgress = words
    .slice(0, visibleCount)
    .map((_word, index) =>
      Math.min(
        1,
        Math.max(0, (time - (appearsAt[index] ?? 0)) / WORD_ENTER_MS),
      ),
    );
  const lastWordProgress = wordProgress.at(-1) ?? 1;

  const sizeTo = sizeForCount(visibleCount);
  let sizeFrom = sizeTo;
  let mergeProgress: number | null = null;

  if (visibleCount > 0 && crossesMerge(visibleCount - 1, visibleCount)) {
    const startedAt = appearsAt[visibleCount - 1] ?? 0;
    const progress = (time - startedAt) / mergeDurationMs;
    if (progress < 1) {
      mergeProgress = Math.max(0, progress);
      sizeFrom = sizeForCount(visibleCount - 1);
    }
  }

  return {
    text: words.slice(0, visibleCount).join(' '),
    visibleCount,
    wordProgress,
    enterMode: enterMode.slice(0, visibleCount),
    lastWordProgress,
    mergeProgress,
    sizeFrom,
    sizeTo,
    gear: enterMode[Math.max(0, visibleCount - 1)] ?? 'word',
  };
}
