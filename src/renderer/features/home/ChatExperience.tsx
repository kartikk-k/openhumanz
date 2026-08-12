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
import { Greeting } from './components/ambient/Greeting';
import { call } from '../../lib/ipc';
import { IPC } from '../../../shared/ipc';
import { useChatStore } from '../../store';

/**
 * Orb positions as EXACT pixel offsets from a corner (like Tailwind's
 * `top-4 right-4`), instead of vague UV fractions. `centered` puts the orb dead
 * center. Everything else anchors the orb's CENTER `px` from the named edges.
 * `toUv` converts to the [x,y] fraction GlassOrb wants for the current window
 * size — so the position stays exact at any size, and GlassOrb still eases the
 * move (animated).
 */
type OrbAnchor =
  | { centered: true }
  | { top?: number; bottom?: number; left?: number; right?: number };

// px from the edges to the orb's CENTER when resting in a chat (top-right).
const REST_ANCHOR: OrbAnchor = { top: 72, right: 72 };
const SPEAKING_ANCHOR: OrbAnchor = { centered: true };
const AMBIENT_ANCHOR: OrbAnchor = { centered: true };

/** Convert a corner-anchored px position to the orb's UV center [x, y]. */
function toUv(a: OrbAnchor, w: number, h: number): [number, number] {
  if ('centered' in a) return [0.5, 0.5];
  let x = 0.5;
  let y = 0.5;
  if (a.left != null) x = a.left / w;
  else if (a.right != null) x = 1 - a.right / w;
  // CSS top → smaller UV y is lower, so top offset maps to (1 - top/h).
  if (a.top != null) y = 1 - a.top / h;
  else if (a.bottom != null) y = a.bottom / h;
  return [x, y];
}

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

  // window size, so exact px orb anchors convert to UV correctly on resize.
  const [win, setWin] = useState<{ w: number; h: number }>(() => ({
    w: typeof window === 'undefined' ? 1440 : window.innerWidth,
    h: typeof window === 'undefined' ? 900 : window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () =>
      setWin({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // clear a stale voice error as soon as the user types.
  useEffect(() => {
    if (chat.draft && voiceError) setVoiceError(null);
  }, [chat.draft, voiceError]);

  const openMicSettings = useCallback(() => {
    void call(IPC.system.openMicSettings, {});
  }, []);

  // Cmd/Ctrl+N → new chat. Esc → cancel the ongoing turn (like the terminal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        void useChatStore.getState().newChat();
        return;
      }
      if (e.key === 'Escape') {
        const st = useChatStore.getState();
        if (st.busy) {
          e.preventDefault();
          void st.cancel();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
        // exact px-anchored position → UV; GlassOrb eases the move (animated).
        center={toUv(
          // eslint-disable-next-line no-nested-ternary
          listening ? SPEAKING_ANCHOR : hasChat ? REST_ANCHOR : AMBIENT_ANCHOR,
          win.w,
          win.h,
        )}
        levelRef={listening ? micLevel : undefined}
        controls={false}
      />

      {/* ── new-chat ── */}
      {!chat.storeBusy && !listening && chat.turns.length > 0 && (
        <div className="fixed bottom-4 left-4 z-40">
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
