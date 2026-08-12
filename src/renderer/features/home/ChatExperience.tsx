/**
 * ChatExperience — the conductor for the home chat.
 *
 * A plain, flowing chat (MessageList): user bubbles on the right, assistant
 * responses on the left (markdown + tool calls + subagents, same detail as the
 * chat tab). One orb (GlassOrb):
 *   - By default it sits at the BOTTOM as a status light (idle / thinking /
 *     working), next to a text composer. Type + Enter to send.
 *   - Hold Space to talk: the orb jumps to a BIG centered overlay on top of
 *     everything and runs voice mode; on release it returns to the bottom and
 *     the transcribed query is sent.
 * The chat text fades out toward the bottom (an alpha mask on the scroll
 * container) so it dissolves behind the orb instead of colliding with it.
 */
import { useCallback, useEffect, useState } from 'react';
import { GlassOrb } from './orb/GlassOrb';
import { useVoiceCapture } from './voice/useVoiceCapture';
import { useHomeChat } from './hooks/useHomeChat';
import { useHoldToTalk } from './hooks/useHoldToTalk';
import { MessageList } from './components/MessageList';
import { Composer } from './components/Composer';
import { VoiceStatus } from './components/VoiceStatus';
import { ActivityChip } from './components/ActivityChip';
import { Greeting } from './components/ambient/Greeting';
import { CENTER_AMBIENT } from './lib/turns';
import { call } from '../../lib/ipc';
import { IPC } from '../../../shared/ipc';
import { useChatStore } from '../../store';

// orb positions (WebGL UV: y=1 top, y=0 bottom).
const CENTER_SPEAKING: [number, number] = [0.5, 0.5]; // big, centered (voice)
const CENTER_TOPRIGHT: [number, number] = [0.9, 0.85]; // resting in a chat

export function ChatExperience() {
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  // voice: record the whole clip, transcribe once on release (batch, English).
  const {
    levelRef: micLevel,
    status: micStatus,
    start: startBatch,
    stop: stopBatch,
  } = useVoiceCapture();

  // chat state derived from the real store.
  const chat = useHomeChat(listening, transcribing, '');

  // hold Space → record → transcribe → send.
  useHoldToTalk({
    startBatch,
    stopBatch,
    submit: chat.submit,
    busy: chat.storeBusy,
    onListeningChange: setListening,
    onTranscribingChange: setTranscribing,
    onVoiceError: setVoiceError,
  });

  // clear a stale voice error as soon as the user types.
  useEffect(() => {
    if (chat.draft && voiceError) setVoiceError(null);
  }, [chat.draft, voiceError]);

  const openMicSettings = useCallback(() => {
    void call(IPC.system.openMicSettings, {});
  }, []);

  const hasChat = chat.inChat;

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* ── message list (normal flowing chat) ── */}
      {hasChat && (
        <MessageList
          turns={chat.turns}
          currentSessionId={chat.currentSessionId}
          scrollRef={chat.scrollRef}
        />
      )}

      {/* ── ambient greeting, before any conversation ── */}
      {!hasChat && !listening && <Greeting />}

      {/* ── the single orb ──
          Resting at the bottom as a status light; jumps to a big centered
          overlay while speaking. Reacts to the mic only while listening. */}
      <GlassOrb
        className="z-30"
        state={chat.orbState}
        // Ambient (no messages): big & centered. Once a conversation starts it
        // smoothly moves to the TOP-RIGHT as a small status light (the orb eases
        // its center per-frame, so changing the target animates). While speaking
        // it's a big centered voice overlay.
        // eslint-disable-next-line no-nested-ternary
        size={listening ? 320 : hasChat ? 90 : 260}
        center={
          // eslint-disable-next-line no-nested-ternary
          listening
            ? CENTER_SPEAKING
            : hasChat
              ? CENTER_TOPRIGHT
              : CENTER_AMBIENT
        }
        levelRef={listening ? micLevel : undefined}
        controls={false}
      />

      {/* ── activity chip (top-right) while tools run ── */}
      <ActivityChip blocks={chat.liveBlocks} running={chat.liveRunning} />

      {/* ── new-chat, top-right ── */}
      {!chat.storeBusy && !listening && chat.turns.length > 0 && (
        <div className="fixed right-4 top-4 z-40">
          <button
            type="button"
            onClick={() => {
              void useChatStore.getState().newChat();
            }}
            className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs text-white/70 backdrop-blur transition hover:text-white"
          >
            New chat
          </button>
        </div>
      )}

      {/* ── bottom composer (hidden while speaking so the big orb has the stage) ── */}
      {!listening && (
        <Composer
          draft={chat.draft}
          onDraftChange={chat.setDraft}
          onSubmit={chat.submit}
          disabled={chat.storeBusy}
          voiceError={voiceError}
        />
      )}

      {/* ── voice status: "Listening…" while speaking; transcribing; denied ── */}
      {listening && (
        <p className="pointer-events-none fixed bottom-10 left-1/2 z-40 -translate-x-1/2 text-sm text-white/50">
          Listening…
        </p>
      )}
      <VoiceStatus
        transcribing={transcribing}
        micDenied={listening && micStatus === 'denied'}
        onOpenMicSettings={openMicSettings}
      />
    </div>
  );
}

export default ChatExperience;
