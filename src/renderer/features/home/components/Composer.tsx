/** Bottom input box composer — controlled text input with submit and voice-error hint. */
export function Composer({
  draft,
  onDraftChange,
  onSubmit,
  disabled,
  voiceError,
}: {
  draft: string;
  onDraftChange: (v: string) => void;
  onSubmit: (text: string) => void;
  disabled: boolean;
  voiceError: string | null;
}) {
  return (
    <div className="pointer-events-none fixed bottom-2 left-1/2 z-40 -translate-x-1/2">
      {/* Blur lives on this WRAPPER, not the <input> — Chromium doesn't
          composite backdrop-filter reliably on native form controls, so the
          input is transparent and this rounded frame does the frosted glass. */}
      <div
        className="pointer-events-auto flex h-12 w-[380px] items-center rounded-full border border-white/15 bg-white/10 px-5"
        style={{
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit(draft);
            }
          }}
          disabled={disabled}
          placeholder={disabled ? 'Thinking…' : 'Ask me anything…'}
          className="h-full w-full bg-transparent text-sm text-white outline-none placeholder:text-white/40 disabled:opacity-60"
        />
      </div>
      {voiceError ? (
        <p className="pointer-events-none mt-1 text-center text-[10px] text-amber-300/80">
          {voiceError}
        </p>
      ) : (
        <p className="pointer-events-none mt-1 text-center text-[10px] text-white/30">
          Hold Space to talk
        </p>
      )}
    </div>
  );
}

export default Composer;
