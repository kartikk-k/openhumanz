/** Bottom voice status — transcribing indicator plus mic-denied settings action. */
export function VoiceStatus({
  transcribing,
  micDenied,
  onOpenMicSettings,
}: {
  transcribing: boolean;
  micDenied: boolean;
  onOpenMicSettings: () => void;
}) {
  if (!transcribing && !micDenied) return null;
  return (
    <div className="fixed bottom-8 left-1/2 z-30 -translate-x-1/2 text-center">
      {transcribing && <p className="text-xs text-white/50">Transcribing…</p>}
      {micDenied && (
        <button
          type="button"
          onClick={onOpenMicSettings}
          className="mt-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs text-white/70 hover:text-white"
        >
          Microphone blocked — Open Settings
        </button>
      )}
    </div>
  );
}

export default VoiceStatus;
