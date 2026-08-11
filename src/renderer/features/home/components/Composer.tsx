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
    <div className="pointer-events-none fixed bottom-10 left-1/2 z-30 -translate-x-1/2">
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
        className="pointer-events-auto h-12 w-[380px] rounded-full border border-white/15 bg-white/10 px-5 text-sm text-white outline-none backdrop-blur placeholder:text-white/40 disabled:opacity-60"
      />
      {voiceError ? (
        <p className="pointer-events-none mt-3 text-center text-xs text-amber-300/80">
          {voiceError}
        </p>
      ) : (
        <p className="pointer-events-none mt-3 text-center text-xs text-white/30">
          Hold Space to talk
        </p>
      )}
    </div>
  );
}

export default Composer;
