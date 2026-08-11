/**
 * AutoMergeText
 *
 * Streaming text that keeps itself centered while it grows: words fade/blur in,
 * and as the visible text crosses length thresholds the whole block MERGES down
 * a size step (52px → 34px → 26px) with a vertical two-line close-up, then later
 * shifts from word-by-word to line-by-line bursts. This is the mechanism the
 * user validated in the source prototype; it is dropped in here verbatim except:
 *   - imports point at ./lib/* (this repo has no `@/` alias),
 *   - SIZE_STYLES is anchored to our 52px hero size (see partition-merge-text),
 *   - an `onDone` callback fires once when the internal clock reaches `duration`,
 *   - width is measured live and re-measured on window resize, so a narrower or
 *     wider window recomputes wrapping/merges instead of using a fixed width.
 *
 * Where to change behavior
 * - Word / line enter (blur, opacity, width): `Word` below
 * - Two-line merge motion: the `merging` overlay in the render tree
 * - When word stream becomes line stream: `LINE_SHIFT_AFTER` / `LINE_RAMP_LINES` in ./lib/timeline
 * - Size steps (3xl / xl / base): `SIZE_STYLES` + `layoutMergeText` in ./lib/partition-merge-text
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  FIRST_LINE_WORDS,
  MERGE_DURATION_MS,
  SIZE_STYLES,
  WORDS_PER_GROUP,
  layoutMergeText,
  type TextSize,
} from './lib/partition-merge-text';
import {
  ACCELERATE,
  LINE_DELAY_MS,
  buildTimeline,
  frameAt,
  wrapWords,
  type EnterMode,
} from './lib/timeline';

const DEFAULT_WORD_DURATION = 220;

export type AutoMergeMeta = {
  duration: number;
  visibleCount: number;
  gear: EnterMode;
};

export type AutoMergeTextProps = {
  /** Full (or accumulated) source text. Revealed over time from the start. */
  text: string;
  /** Gap between words during the early word-by-word phase. */
  wordDuration?: number;
  /** Gap between line bursts after the gear shift. */
  lineDuration?: number;
  /** How fast the word→line ramp happens. 1 = default, higher reaches full lines sooner. */
  accelerate?: number;
  /** Extra hold after a size merge (3xl→xl, xl→base). */
  mergePause?: number;
  /** Length of the two-line close-up merge motion. */
  mergeAnimation?: number;
  className?: string;
  /**
   * Optional playhead in ms. Omit for an internal clock.
   * Pass with `onTimeChange` to scrub from a parent (prototype timeline).
   */
  time?: number;
  /** Optional play/pause. Omit to autoplay. */
  playing?: boolean;
  onTimeChange?: (time: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  /** Fires when duration / visible word count / gear changes. Useful for debug UI. */
  onMetaChange?: (meta: AutoMergeMeta) => void;
  /** Fires once when the internal clock reaches the end of the stream. */
  onDone?: () => void;
  /** Fires on every reveal/merge frame so a parent can keep the view centered. */
  onGrow?: () => void;
};

function easeInOut(value: number) {
  return value < 0.5 ? 2 * value * value : 1 - (2 - 2 * value) ** 2 / 2;
}

/** Enter animation: width 0→measured, opacity 0→1, blur 5px→0, ease-in-out. */
function Word({
  word,
  width,
  progress,
}: {
  word: string;
  width: number;
  progress: number;
}) {
  const amount = Math.min(1, Math.max(0, progress));

  if (amount >= 1) {
    return <span>{word}</span>;
  }

  const eased = easeInOut(amount);

  return (
    <span
      className="relative inline-block text-left align-baseline"
      style={{
        width: width > 0 ? width * eased : undefined,
        opacity: eased,
      }}
    >
      {/* invisible copy of the word reserves the exact line-box height while
          the visible copy (below) blurs in over it — no layout jump. */}
      <span aria-hidden className="invisible whitespace-pre">
        {word}
      </span>
      <span
        className="absolute inset-y-0 left-0 overflow-hidden whitespace-pre text-left"
        style={{
          width: '100%',
          filter: `blur(${5 * (1 - eased)}px)`,
        }}
      >
        {word}
      </span>
    </span>
  );
}

function Line({
  words,
  startIndex,
  widths,
  spaceWidth,
  wordProgress,
  enterMode,
}: {
  words: string[];
  startIndex: number;
  widths: number[];
  spaceWidth: number;
  wordProgress: number[];
  enterMode: EnterMode[];
}) {
  const groups: Array<{ start: number; words: string[] }> = [];

  for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
    const index = startIndex + wordIndex;
    const mode = enterMode[index] ?? 'word';
    const progress = wordProgress[index] ?? 1;
    const last = groups.at(-1);
    const lastProgress = last ? (wordProgress[last.start] ?? 1) : null;
    const canJoin =
      last != null &&
      mode === 'line' &&
      (enterMode[last.start] ?? 'word') === 'line' &&
      lastProgress != null &&
      Math.abs(lastProgress - progress) < 0.001;

    if (canJoin && last) {
      last.words.push(words[wordIndex] ?? '');
    } else {
      groups.push({ start: index, words: [words[wordIndex] ?? ''] });
    }
  }

  return (
    <>
      {groups.map((group, groupIndex) => {
        const width = group.words.reduce((total, _word, wordIndex) => {
          const gap = wordIndex === 0 ? 0 : spaceWidth;
          return total + gap + (widths[group.start + wordIndex] ?? 0);
        }, 0);

        return (
          <span key={group.start}>
            <Word
              word={group.words.join(' ')}
              width={width}
              progress={wordProgress[group.start] ?? 1}
            />
            {groupIndex < groups.length - 1 ? ' ' : null}
          </span>
        );
      })}
    </>
  );
}

function linesOf(text: string, wordsPerGroup: number) {
  return layoutMergeText(text, wordsPerGroup).lines;
}

function displayLines(text: string, size: TextSize, wordsPerGroup: number) {
  if (size !== 'base') return linesOf(text, wordsPerGroup);
  return wrapWords(text.trim().split(/\s+/).filter(Boolean)).map((line) =>
    line.join(' '),
  );
}

function committedLineStyle(lineIndex: number, nowrap: boolean) {
  if (lineIndex !== 0 || !nowrap) return undefined;

  return {
    whiteSpace: 'nowrap',
  } as const;
}

function mergeFromCount(sizeFrom: TextSize) {
  if (sizeFrom === '3xl') return WORDS_PER_GROUP;
  if (sizeFrom === 'xl') return WORDS_PER_GROUP * 2;
  return FIRST_LINE_WORDS;
}

export function AutoMergeText({
  text,
  wordDuration = DEFAULT_WORD_DURATION,
  lineDuration = LINE_DELAY_MS,
  accelerate = ACCELERATE,
  mergePause = MERGE_DURATION_MS,
  mergeAnimation = MERGE_DURATION_MS,
  className,
  time: timeProp,
  playing: playingProp,
  onTimeChange,
  onPlayingChange,
  onMetaChange,
  onDone,
  onGrow,
}: AutoMergeTextProps) {
  const wordsPerGroup = WORDS_PER_GROUP;
  const words = useMemo(() => text.trim().split(/\s+/).filter(Boolean), [text]);
  const {
    appearsAt,
    enterMode: timelineEnterMode,
    duration,
  } = useMemo(
    () =>
      buildTimeline(words, wordDuration, mergePause, lineDuration, accelerate),
    [accelerate, lineDuration, mergePause, wordDuration, words],
  );

  const [internalTime, setInternalTime] = useState(0);
  const [internalPlaying, setInternalPlaying] = useState(true);
  const time = timeProp ?? internalTime;
  const playing = playingProp ?? internalPlaying;
  const timeRef = useRef(time);
  const playingRef = useRef(playing);
  timeRef.current = time;
  playingRef.current = playing;
  const wordCount = words.length;
  const previousWordCount = useRef(wordCount);

  const onDoneRef = useRef(onDone);
  const onGrowRef = useRef(onGrow);
  onDoneRef.current = onDone;
  onGrowRef.current = onGrow;
  const doneFiredRef = useRef(false);

  const setTime = (next: number | ((current: number) => number)) => {
    const value = typeof next === 'function' ? next(timeRef.current) : next;
    timeRef.current = value;
    if (timeProp == null) setInternalTime(value);
    onTimeChange?.(value);
  };

  const setPlaying = (next: boolean | ((current: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(playingRef.current) : next;
    playingRef.current = value;
    if (playingProp == null) setInternalPlaying(value);
    onPlayingChange?.(value);
  };

  useEffect(() => {
    if (wordCount < previousWordCount.current) {
      doneFiredRef.current = false;
      setTime(0);
      setPlaying(true);
    }
    previousWordCount.current = wordCount;
    // setTime/setPlaying are stable enough for this reset guard
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wordCount]);

  useEffect(() => {
    if (time > duration) setTime(duration);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, time]);

  useEffect(() => {
    if (!playing) return undefined;

    let frameId = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const delta = now - last;
      last = now;
      setTime((current) => {
        const next = current + delta;
        if (next >= duration) {
          setPlaying(false);
          return duration;
        }
        return next;
      });
      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, playing]);

  const frame = frameAt(
    time,
    words,
    appearsAt,
    mergeAnimation,
    timelineEnterMode,
  );

  useEffect(() => {
    onMetaChange?.({
      duration,
      visibleCount: frame.visibleCount,
      gear: frame.gear,
    });
  }, [duration, frame.gear, frame.visibleCount, onMetaChange]);

  // keep the parent view centered as text reveals / merges
  useEffect(() => {
    onGrowRef.current?.();
  }, [frame.visibleCount, frame.mergeProgress]);

  // fire onDone exactly once when the stream reaches its end
  useEffect(() => {
    if (!doneFiredRef.current && duration > 0 && time >= duration) {
      doneFiredRef.current = true;
      onDoneRef.current?.();
    }
  }, [time, duration]);

  const { wordProgress } = frame;
  const { enterMode } = frame;
  const { mergeProgress } = frame;
  const { sizeFrom } = frame;
  const { sizeTo } = frame;

  const { size } = layoutMergeText(frame.text, wordsPerGroup);
  const resolvedTo = sizeTo ?? size;
  const resolvedFrom = sizeFrom ?? resolvedTo;
  const fromMetrics = SIZE_STYLES[resolvedFrom];
  const toMetrics = SIZE_STYLES[resolvedTo];
  const probeRef = useRef<HTMLSpanElement>(null);
  const [widths, setWidths] = useState<number[]>([]);
  const [spaceWidth, setSpaceWidth] = useState(0);
  // bumped on window resize to force a re-measure at the new width
  const [resizeTick, setResizeTick] = useState(0);
  const merging = mergeProgress != null && mergeProgress < 1;
  const progress = merging ? Math.min(1, Math.max(0, mergeProgress ?? 0)) : 1;
  const visibleWords = frame.text.trim().split(/\s+/).filter(Boolean);

  useEffect(() => {
    const onResize = () => setResizeTick((tick) => tick + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useLayoutEffect(() => {
    const probe = probeRef.current;
    if (!probe) return;

    probe.textContent = ' ';
    const nextSpace = probe.getBoundingClientRect().width;
    setSpaceWidth((current) =>
      Math.abs(current - nextSpace) < 0.5 ? current : nextSpace,
    );

    const next = text
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => {
        probe.textContent = word;
        return probe.getBoundingClientRect().width;
      });

    setWidths((current) => {
      if (
        current.length === next.length &&
        current.every((value, index) => value === next[index])
      ) {
        return current;
      }
      return next;
    });
  }, [resolvedTo, text, resizeTick]);

  const fromText = visibleWords
    .slice(0, mergeFromCount(resolvedFrom))
    .join(' ');
  const fromLines = linesOf(fromText, wordsPerGroup);
  const toLines = displayLines(frame.text, resolvedTo, wordsPerGroup);
  const committedLines = displayLines(frame.text, resolvedTo, wordsPerGroup);
  const nowrapFirst = resolvedTo !== 'base';
  const nowrapFromFirst = resolvedFrom !== 'base';

  return (
    <div
      className={['relative w-full min-w-0 text-center', className]
        .filter(Boolean)
        .join(' ')}
    >
      <span
        ref={probeRef}
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 whitespace-pre"
        style={{
          fontSize: toMetrics.fontSize,
          lineHeight: toMetrics.lineHeight,
        }}
      />

      {words.length === 0 ? (
        <p
          className="text-white/25"
          style={{
            fontSize: SIZE_STYLES['3xl'].fontSize,
            lineHeight: SIZE_STYLES['3xl'].lineHeight,
          }}
        >
          &nbsp;
        </p>
      ) : null}

      {words.length > 0 && visibleWords.length > 0 && merging ? (
        // Merge overlay: outgoing lines lift + blur; incoming size fades in.
        <div
          className="relative"
          style={{
            minHeight: fromMetrics.linePx * Math.max(fromLines.length, 1),
          }}
        >
          <div>
            {fromLines.map((line, lineIndex) => {
              const lineWords = line.split(/\s+/).filter(Boolean);
              const startIndex = fromLines
                .slice(0, lineIndex)
                .reduce(
                  (accCount, current) =>
                    accCount + current.split(/\s+/).filter(Boolean).length,
                  0,
                );

              return (
                <p
                  // eslint-disable-next-line react/no-array-index-key
                  key={`from-${lineIndex}`}
                  style={{
                    fontSize: fromMetrics.fontSize,
                    lineHeight: fromMetrics.lineHeight,
                    height: fromMetrics.linePx,
                    ...committedLineStyle(lineIndex, nowrapFromFirst),
                    transform:
                      lineIndex === 1
                        ? `translateY(${-fromMetrics.linePx * progress}px)`
                        : undefined,
                    filter: `blur(${10 * progress}px)`,
                    opacity: 1 - progress,
                  }}
                >
                  <Line
                    words={lineWords}
                    startIndex={startIndex}
                    widths={widths}
                    spaceWidth={spaceWidth}
                    wordProgress={[]}
                    enterMode={[]}
                  />
                </p>
              );
            })}
          </div>

          <div
            className="absolute inset-x-0 top-0"
            style={{
              fontSize: toMetrics.fontSize,
              lineHeight: toMetrics.lineHeight,
              filter: `blur(${10 * (1 - progress)}px)`,
              opacity: progress,
            }}
          >
            {toLines.map((line, lineIndex) => {
              const lineWords = line.split(/\s+/).filter(Boolean);
              const startIndex = toLines
                .slice(0, lineIndex)
                .reduce(
                  (accCount, current) =>
                    accCount + current.split(/\s+/).filter(Boolean).length,
                  0,
                );

              return (
                <p
                  // eslint-disable-next-line react/no-array-index-key
                  key={`to-${lineIndex}`}
                  style={{
                    lineHeight: toMetrics.lineHeight,
                    ...committedLineStyle(lineIndex, nowrapFirst),
                  }}
                >
                  <Line
                    words={lineWords}
                    startIndex={startIndex}
                    widths={widths}
                    spaceWidth={spaceWidth}
                    wordProgress={wordProgress}
                    enterMode={enterMode}
                  />
                </p>
              );
            })}
          </div>
        </div>
      ) : null}

      {words.length > 0 && visibleWords.length > 0 && !merging ? (
        <div
          style={{
            fontSize: toMetrics.fontSize,
            lineHeight: toMetrics.lineHeight,
          }}
        >
          {committedLines.map((line, lineIndex) => {
            const lineWords = line.split(/\s+/).filter(Boolean);
            const startIndex = committedLines
              .slice(0, lineIndex)
              .reduce(
                (accCount, current) =>
                  accCount + current.split(/\s+/).filter(Boolean).length,
                0,
              );

            return (
              <p
                // eslint-disable-next-line react/no-array-index-key
                key={lineIndex}
                style={{
                  lineHeight: toMetrics.lineHeight,
                  ...committedLineStyle(lineIndex, nowrapFirst),
                }}
              >
                <Line
                  words={lineWords}
                  startIndex={startIndex}
                  widths={widths}
                  spaceWidth={spaceWidth}
                  wordProgress={wordProgress}
                  enterMode={enterMode}
                />
              </p>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export default AutoMergeText;
