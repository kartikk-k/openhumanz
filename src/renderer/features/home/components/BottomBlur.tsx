/**
 * BottomBlur — a progressive (gradually increasing) blur rising from the bottom
 * of the CHAT CONTAINER only (not the whole page).
 *
 * A single backdrop-filter with a mask only fades the SAME blur in/out (which
 * reads as a glow, not a ramp). Instead we stack several layers, each with a
 * stronger blur AND a mask window shifted further up, so the effective blur
 * strength ramps smoothly from none at the top to heavy at the bottom — the
 * MagicUI "progressive blur" technique. Chat text scrolling under the bottom orb
 * is softly, progressively blurred; text higher up stays sharp.
 *
 * Rendered as an ABSOLUTE overlay inside the chat container (its parent must be
 * `relative`), so it never touches the ambient corner cards or the composer.
 */

// Increasing blur radii; each layer's mask window is centered a bit lower so
// the strong blur only applies near the bottom.
const BLUR_PX = [0.5, 1, 2, 4, 8, 16, 32];

export function BottomBlur({ height = '38%' }: { height?: string }) {
  const n = BLUR_PX.length;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20"
      style={{ height }}
    >
      {BLUR_PX.map((blur, i) => {
        // each layer is transparent above its window and opaque below, so
        // stacking them makes the blur ramp up toward the bottom.
        const start = (i / n) * 100;
        const mid = ((i + 0.5) / n) * 100;
        const mask = `linear-gradient(to top, rgba(0,0,0,1) ${start}%, rgba(0,0,0,1) ${mid}%, rgba(0,0,0,0) ${Math.min(100, mid + 100 / n)}%)`;
        return (
          <div
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            className="absolute inset-0"
            style={{
              backdropFilter: `blur(${blur}px)`,
              WebkitBackdropFilter: `blur(${blur}px)`,
              maskImage: mask,
              WebkitMaskImage: mask,
            }}
          />
        );
      })}
    </div>
  );
}

export default BottomBlur;
