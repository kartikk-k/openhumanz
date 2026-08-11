import {
  settledFont,
  settledLines,
  settledNowrap,
  COLUMN_WIDTH,
} from '../lib/settledText';

/**
 * SettledAnswer — a past assistant turn, rendered statically at the exact size
 * and line layout AutoMergeText settles at. No animation: past turns must not
 * re-stream when scrolled back into view.
 */
export function SettledAnswer({ text }: { text: string }) {
  const font = settledFont(text);
  const lines = settledLines(text);
  const nowrap = settledNowrap(text);
  return (
    <div
      className="text-center font-medium tracking-tight text-white/95"
      style={{
        fontSize: font.fontSize,
        lineHeight: font.lineHeight,
        maxWidth: COLUMN_WIDTH,
      }}
    >
      {lines.map((line, i) => (
        <div
          // eslint-disable-next-line react/no-array-index-key
          key={i}
          style={{ whiteSpace: nowrap ? 'nowrap' : 'normal' }}
        >
          {line}
        </div>
      ))}
    </div>
  );
}

/**
 * LiveTranscript — the realtime STT transcript shown centered near the top
 * while the user is speaking. Sized like a forming question. Realtime STT
 * already streams the words in, so there's no extra animation here.
 */
export function LiveTranscript({ text }: { text: string }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[22vh] z-20 flex justify-center px-6">
      <div className="w-full max-w-[min(880px,92vw)]">
        <p
          className="text-center font-medium tracking-tight text-white/70"
          style={{
            fontSize: '34px',
            lineHeight: 1.3,
            textWrap: 'balance',
          }}
        >
          {text}
        </p>
      </div>
    </div>
  );
}
