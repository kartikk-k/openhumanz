/**
 * StreamingText — a single line that shrinks to fit as it streams.
 *
 * The behaviour (length-independent, reactive to width):
 *   - Text streams onto ONE line at a large base size.
 *   - As words arrive the line gets wider; whenever it would overflow the
 *     container it SHRINKS (via transform: scale) so it always stays on one
 *     line. The scale is transitioned, so the shrink glides — pure GPU
 *     transform, no reflow, no jerk.
 *   - It shrinks only down to a readable floor (~16px effective). Once it hits
 *     the floor, it switches to normal wrapping so a very long response flows
 *     onto multiple lines at that size instead of becoming unreadable.
 *   - Words still blur-fade in as they arrive.
 *
 * Nothing depends on the final length — it just measures the current line width
 * every reveal and fits it, exactly like a live agent stream would need.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

// base (largest) font. The line scales DOWN from here to fit the container.
const BASE_FONT = 52; // px
// don't let the effective size (BASE_FONT * scale) drop below this — then wrap.
const MIN_FONT = 16; // px
const MIN_SCALE = MIN_FONT / BASE_FONT;

// steady release rate (ms between tokens). Lower = faster stream.
const TOKEN_MS = 95;
// each token's entrance animation (must match .st-token in App.css)
const TOKEN_ANIM_MS = 1000;
// how long a fit-shrink glides
const FIT_MS = 320;

export interface StreamingTextProps {
  /** the full text to stream in */
  text: string;
  /** stream token-by-token (true) or show instantly (false, for past turns) */
  animate?: boolean;
  className?: string;
  /**
   * 'auto' uses the shrink-to-fit sizing. 'compact' is a fixed small header
   * size — for the user question once answered.
   */
  size?: 'auto' | 'compact';
  /** fires as tokens land / the block resizes — keep the view centered */
  onGrow?: () => void;
  /** fires once the last token has landed */
  onDone?: () => void;
}

// split into word+whitespace tokens, keeping whitespace so spacing is exact
function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

export function StreamingText({
  text,
  animate = true,
  className,
  size = 'auto',
  onGrow,
  onDone,
}: StreamingTextProps) {
  const tokens = useMemo(() => tokenize(text), [text]);

  // how many tokens are currently revealed
  const [count, setCount] = useState(animate ? 0 : tokens.length);
  // fit scale (1 = base size, smaller = shrunk to fit one line)
  const [scale, setScale] = useState(1);
  // once we hit the floor, wrap instead of shrinking further
  const [wrapped, setWrapped] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null); // fixed-width container
  const lineRef = useRef<HTMLParagraphElement>(null); // the scaled line
  const onGrowRef = useRef(onGrow);
  const onDoneRef = useRef(onDone);
  onGrowRef.current = onGrow;
  onDoneRef.current = onDone;

  const compact = size === 'compact';

  // After each reveal, measure the natural (unscaled) line width and compute the
  // scale that makes it fit the container. If that scale would drop below the
  // floor, clamp to the floor and switch to wrapping instead.
  useLayoutEffect(() => {
    if (!animate || compact) return;
    const wrap = wrapRef.current;
    const line = lineRef.current;
    if (!wrap || !line) return;

    if (wrapped) {
      onGrowRef.current?.();
      return;
    }

    const avail = wrap.clientWidth;
    // scrollWidth is the natural single-line width — CSS transforms don't affect
    // layout metrics, so this is already the UNSCALED width.
    const natural = line.scrollWidth;
    if (natural <= 0 || avail <= 0) return;

    const fit = Math.min(1, avail / natural);
    if (fit <= MIN_SCALE) {
      // can't stay on one line without going below the floor → wrap at floor
      setWrapped(true);
      setScale(MIN_SCALE);
    } else if (Math.abs(fit - scale) > 0.005) {
      setScale(fit);
    }
    onGrowRef.current?.();
  }, [count, animate, compact, scale, wrapped]);

  useEffect(() => {
    if (!animate) {
      onGrowRef.current?.();
      onDoneRef.current?.();
      return undefined;
    }

    setCount(0);
    setScale(1);
    setWrapped(false);
    // reveal at a steady rate off a monotonic clock (no setTimeout drift)
    const start = performance.now();
    let raf = 0;
    let doneTimer: ReturnType<typeof setTimeout>;
    let shown = 0;

    const tick = (now: number) => {
      const target = Math.min(
        tokens.length,
        Math.floor((now - start) / TOKEN_MS),
      );
      if (target !== shown) {
        shown = target;
        setCount(shown);
        onGrowRef.current?.();
      }
      if (shown < tokens.length) {
        raf = requestAnimationFrame(tick);
      } else {
        doneTimer = setTimeout(() => onDoneRef.current?.(), TOKEN_ANIM_MS);
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(doneTimer);
    };
    // stream once per text; caller keys the component to restart
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, animate]);

  // compact question: simple fixed small size, normal wrapping
  if (compact) {
    return (
      <p
        className={className}
        style={{
          textAlign: 'center',
          textWrap: 'pretty',
          fontWeight: 500,
          letterSpacing: '-0.02em',
          lineHeight: 1.25,
          margin: '0 auto',
          fontSize: '19px',
          maxWidth: '46ch',
        }}
      >
        {(animate ? tokens.slice(0, count) : tokens).map((tok, idx) => (
          <span
            // eslint-disable-next-line react/no-array-index-key
            key={idx}
            className={animate ? 'st-token' : undefined}
            style={{ display: 'inline-block', whiteSpace: 'pre-wrap' }}
          >
            {tok}
          </span>
        ))}
      </p>
    );
  }

  return (
    <div
      ref={wrapRef}
      className={className}
      style={{
        width: 'min(880px, 92vw)',
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <p
        ref={lineRef}
        style={{
          textAlign: 'center',
          fontWeight: 500,
          letterSpacing: '-0.02em',
          lineHeight: 1.25,
          margin: 0,
          fontSize: `${BASE_FONT}px`,
          // one line while shrinking; wrap once we hit the floor
          whiteSpace: wrapped ? 'normal' : 'nowrap',
          transform: wrapped ? 'none' : `scale(${scale})`,
          transformOrigin: 'center center',
          willChange: 'transform',
          // the shrink glides; wrapped text uses its committed floor size
          transition: `transform ${FIT_MS}ms cubic-bezier(0.22,1,0.36,1)`,
          ...(wrapped ? { fontSize: `${MIN_FONT}px`, maxWidth: '100%' } : null),
        }}
      >
        {(animate ? tokens.slice(0, count) : tokens).map((tok, idx) => (
          <span
            // eslint-disable-next-line react/no-array-index-key
            key={idx}
            className={animate ? 'st-token' : undefined}
            style={{ display: 'inline-block', whiteSpace: 'pre' }}
          >
            {tok}
          </span>
        ))}
      </p>
    </div>
  );
}

export default StreamingText;
