import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { settledLines, COLUMN_WIDTH } from '../lib/settledText';

const SETTLED_COMPACT_PX = 19; // final compact size once answered
const COLLAPSE_MS = 520; // how long the asked→compact merge takes
// The big "asked" layer fades/blurs out FASTER and earlier than it scales, so
// it's gone before you register the shrink — otherwise watching it scale all
// the way down reads as a "zoom out". Exit is front-loaded (ease-out, short).
const ASKED_EXIT_MS = 300;

/**
 * SettledQuestion — the user question after it has finished streaming.
 *
 * When the answer arrives it must go from the big (possibly two-line) "asked"
 * layout to a small one-line compact header. Animating font-size reflows the
 * wrap discretely (two lines snap to one BEFORE shrinking) — the jarring step.
 *
 * Instead we cross-fade like AutoMergeText's line merge: two layers stacked and
 * centered — the big "asked" layout (kept at its own wrap the whole time) scales
 * DOWN + blurs + fades OUT, while the compact one-line layout blurs + fades IN.
 * Nothing reflows mid-flight, so the two lines organically dissolve into one.
 */
export function SettledQuestion({
  text,
  answered,
  askedFont,
  onGrow,
}: {
  text: string;
  answered: boolean;
  askedFont: { fontSize: string; lineHeight: string };
  onGrow?: () => void;
}) {
  const grow = useRef(onGrow);
  grow.current = onGrow;

  const bigRef = useRef<HTMLDivElement>(null);
  const compactRef = useRef<HTMLParagraphElement>(null);
  // measured heights of each layout; the container animates BETWEEN them so the
  // reposition (block shrinking) happens ON THE SAME CLOCK as the crossfade,
  // instead of an instant position jump followed by a separate fade.
  const [bigH, setBigH] = useState<number | null>(null);
  const [compactH, setCompactH] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (bigRef.current) setBigH(bigRef.current.offsetHeight);
    if (compactRef.current) setCompactH(compactRef.current.offsetHeight);
  }, [text, askedFont.fontSize]);

  // fire onGrow across the whole collapse so the parent keeps it centered as the
  // block height animates (not just once at the start).
  useEffect(() => {
    grow.current?.();
    if (!answered) return undefined;
    const id = window.setInterval(() => grow.current?.(), 60);
    const stop = window.setTimeout(() => window.clearInterval(id), COLLAPSE_MS);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(stop);
    };
  }, [answered]);

  // AutoMergeText's committed lines (see settledLines): each rendered on its own
  // line, nowrap, so the layout is byte-identical to the last streamed frame.
  const askedLines = settledLines(text);

  const height = answered ? compactH : bigH;

  return (
    <div
      className="relative flex w-full items-center justify-center text-center font-medium tracking-tight text-white/45"
      style={{
        // height animates big→compact together with the crossfade → one motion.
        height: height ?? undefined,
        transition: `height ${COLLAPSE_MS}ms cubic-bezier(0.22,1,0.36,1)`,
        willChange: 'height',
      }}
    >
      {/* big "asked" layout — its own committed line split; blurs+fades out.
          Kept absolute+centered the whole time so it never affects flow; the
          container height (above) is what moves. */}
      <div
        ref={bigRef}
        aria-hidden={answered}
        className="absolute left-1/2 top-1/2"
        style={{
          margin: 0,
          fontSize: askedFont.fontSize,
          lineHeight: askedFont.lineHeight,
          transform: answered
            ? 'translate(-50%,-50%) scale(0.9)'
            : 'translate(-50%,-50%) scale(1)',
          transformOrigin: 'center center',
          filter: answered ? 'blur(10px)' : 'blur(0)',
          opacity: answered ? 0 : 1,
          transition:
            `transform ${COLLAPSE_MS}ms cubic-bezier(0.22,1,0.36,1), ` +
            `filter ${ASKED_EXIT_MS}ms cubic-bezier(0.4,0,1,1), ` +
            `opacity ${ASKED_EXIT_MS}ms cubic-bezier(0.4,0,1,1)`,
          willChange: 'transform, filter, opacity',
          // cap at the column but SIZE TO CONTENT, so each pre-split line sits at
          // its natural width and the block stays centered — the nowrap lines
          // below can't be re-wrapped narrower.
          maxWidth: COLUMN_WIDTH,
          width: 'max-content',
        }}
      >
        {/* each committed line on its OWN line, nowrap — identical to the last
            streamed frame, whether short (layoutMergeText) or long (wrapWords). */}
        {askedLines.map((line, i) => (
          <div
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            style={{ whiteSpace: 'nowrap' }}
          >
            {line}
          </div>
        ))}
      </div>

      {/* compact one-line layout — blurs+fades in, centered */}
      <p
        ref={compactRef}
        aria-hidden={!answered}
        className="absolute left-1/2 top-1/2"
        style={{
          margin: 0,
          fontSize: `${SETTLED_COMPACT_PX}px`,
          lineHeight: 1.35,
          // wrap into a tidy compact block; a long question at 19px must NOT be
          // forced onto one line (that overflowed off-screen).
          maxWidth: '46ch',
          width: 'max-content',
          whiteSpace: 'normal',
          textWrap: 'balance',
          transform: answered
            ? 'translate(-50%,-50%) scale(1)'
            : 'translate(-50%,-50%) scale(1.12)',
          transformOrigin: 'center center',
          filter: answered ? 'blur(0)' : 'blur(8px)',
          opacity: answered ? 1 : 0,
          transition:
            `transform ${COLLAPSE_MS}ms cubic-bezier(0.22,1,0.36,1), ` +
            `filter ${COLLAPSE_MS}ms cubic-bezier(0.22,1,0.36,1), ` +
            `opacity ${COLLAPSE_MS}ms ease`,
          willChange: 'transform, filter, opacity',
          pointerEvents: answered ? undefined : 'none',
        }}
      >
        {text}
      </p>
    </div>
  );
}

export default SettledQuestion;
