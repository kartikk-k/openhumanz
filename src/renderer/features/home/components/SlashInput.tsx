/**
 * SlashInput — the hidden-by-default typing surface for the home screen.
 *
 * There is no visible input bar. Pressing "/" opens this: a caret in the CENTER
 * of the screen, exactly where a spoken question would stream, styled like a
 * forming question (large, centered). Type, Enter sends, Esc cancels. Voice
 * (hold Space) stays the primary path; this is the quiet fallback for typing.
 */
import { useEffect, useRef } from 'react';

export function SlashInput({
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // focus on open, and auto-grow the textarea to fit.
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [value]);

  return (
    <div className="flex w-full justify-center">
      <div className="w-full max-w-[min(880px,92vw)]">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit(value);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
          placeholder="Type your question…"
          className="pointer-events-auto w-full resize-none overflow-hidden bg-transparent text-center font-medium tracking-tight text-white/90 caret-white outline-none placeholder:text-white/25"
          style={{
            fontSize: '34px',
            lineHeight: 1.3,
          }}
        />
        <p className="pointer-events-none mt-3 text-center text-xs text-white/25">
          Enter to send · Esc to cancel
        </p>
      </div>
    </div>
  );
}

export default SlashInput;
