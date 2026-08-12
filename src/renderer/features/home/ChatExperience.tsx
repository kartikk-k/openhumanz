/**
 * ChatExperience — the conductor for the home voice/chat flow.
 *
 * There is exactly ONE orb (GlassOrb). It stays centered and ambient until there
 * is real content (a conversation), then drops. Hold Space to talk: we record
 * the whole clip, transcribe it once on release (OpenAI, English), and send the
 * resulting query to Claude Code; the reply streams below. Press "/" to type
 * instead — same flow without voice.
 *
 * This file is deliberately thin — it wires hooks (useHomeChat, useVoiceCapture,
 * useHoldToTalk) to presentational components (Conversation, SlashInput,
 * VoiceStatus, ActivityChip, Greeting). Behaviour lives in those.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { GlassOrb } from './orb/GlassOrb';
import { useVoiceCapture } from './voice/useVoiceCapture';
import { useHomeChat } from './hooks/useHomeChat';
import { useHoldToTalk } from './hooks/useHoldToTalk';
import { Conversation } from './components/Conversation';
import { SlashInput } from './components/SlashInput';
import { VoiceStatus } from './components/VoiceStatus';
import { ActivityChip } from './components/ActivityChip';
import { Greeting } from './components/ambient/Greeting';
import { CENTER_AMBIENT, CENTER_CHAT } from './lib/turns';
import { call } from '../../lib/ipc';
import { IPC } from '../../../shared/ipc';
import { useChatStore } from '../../store';

export function ChatExperience() {
  // ── voice-only UI state (chat state lives in useHomeChat) ──
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  // there is no visible input bar — press "/" to type in the center.
  const [typing, setTyping] = useState(false);

  // voice: record the whole clip, transcribe once on release (batch, English).
  const {
    levelRef: micLevel,
    status: micStatus,
    start: startBatch,
    stop: stopBatch,
  } = useVoiceCapture();

  // the typing section (rendered inside the scroll flow when in chat), so we can
  // scroll it into fresh view when "/" opens it.
  const typingSlotRef = useRef<HTMLElement>(null);

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

  const openMicSettings = useCallback(() => {
    void call(IPC.system.openMicSettings, {});
  }, []);

  // "/" opens the inline typing surface (no visible input bar otherwise).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.repeat) return;
      const t = e.target as HTMLElement | null;
      const inField =
        !!t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.isContentEditable);
      if (inField || listening || chat.storeBusy) return;
      e.preventDefault();
      setTyping(true);
      // scroll the fresh typing section into view once it mounts.
      window.setTimeout(() => {
        typingSlotRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      }, 50);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listening, chat.storeBusy]);

  const submitTyped = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setTyping(false);
      chat.setDraft('');
      chat.submit(trimmed);
    },
    [chat],
  );

  // confirm-card "Send" → tell the agent to go ahead. "Edit" → open the typing
  // surface pre-filled with the draft so the user can tweak it.
  const onConfirmSend = useCallback(() => {
    chat.submit('Yes, send it.');
  }, [chat]);
  const onConfirmEdit = useCallback(
    (detail: string) => {
      chat.setDraft(detail);
      setTyping(true);
    },
    [chat],
  );

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* the single orb — stays centered until there is content, then drops. */}
      <GlassOrb
        state={chat.orbState}
        size={chat.orbDropped ? 150 : 300}
        center={chat.orbDropped ? CENTER_CHAT : CENTER_AMBIENT}
        levelRef={listening ? micLevel : undefined}
        controls={false}
      />

      {/* activity chip — humanized 'what's happening' while tools run */}
      <ActivityChip blocks={chat.liveBlocks} running={chat.liveRunning} />

      {/* new-chat, top-right — starts a fresh session */}
      {!chat.storeBusy && !listening && chat.turns.length > 0 && (
        <div className="fixed right-4 top-4 z-30">
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

      {/* ambient greeting — hidden once in chat, while speaking, or typing */}
      {!chat.inChat && !listening && !typing && <Greeting />}

      {/* while recording: a quiet "Listening…" (batch — no live transcript;
          the transcribed query appears once you release). */}
      {listening && (
        <p className="pointer-events-none fixed inset-x-0 top-[30vh] z-20 text-center text-lg text-white/40">
          Listening…
        </p>
      )}

      {/* AMBIENT typing (no conversation yet): centered where a voice question
          would stream. */}
      {typing && !chat.inChat && (
        <div className="pointer-events-none fixed inset-x-0 top-[30vh] z-30 flex justify-center px-6">
          <SlashInput
            value={chat.draft}
            onChange={chat.setDraft}
            onSubmit={submitTyped}
            onCancel={() => {
              setTyping(false);
              chat.setDraft('');
            }}
          />
        </div>
      )}

      {/* scrollable conversation. When typing IN chat, the input is a trailing
          full-screen section that scrolls into fresh space (never overlaps). */}
      {chat.inChat && (
        <Conversation
          turns={chat.turns}
          currentSessionId={chat.currentSessionId}
          scrollRef={chat.scrollRef}
          liveExchangeRef={chat.liveExchangeRef}
          onScroll={chat.onScroll}
          recenter={chat.recenter}
          onConfirmSend={onConfirmSend}
          onConfirmEdit={onConfirmEdit}
          typingSlotRef={typingSlotRef}
          typingSlot={
            typing ? (
              <SlashInput
                value={chat.draft}
                onChange={chat.setDraft}
                onSubmit={submitTyped}
                onCancel={() => {
                  setTyping(false);
                  chat.setDraft('');
                }}
              />
            ) : undefined
          }
        />
      )}

      {/* idle hint — how to interact, when nothing else is on screen */}
      {!listening && !typing && !transcribing && !chat.storeBusy && (
        <p className="pointer-events-none fixed bottom-10 left-1/2 z-30 -translate-x-1/2 text-center text-xs text-white/25">
          Hold Space to talk · / to type
        </p>
      )}

      {/* voice errors + transcribing / mic-denied status */}
      {voiceError && !listening && !typing && (
        <p className="pointer-events-none fixed bottom-16 left-1/2 z-30 -translate-x-1/2 text-center text-xs text-amber-300/80">
          {voiceError}
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
