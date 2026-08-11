/**
 * ChatExperience — the conductor for the home voice/chat flow.
 *
 * There is exactly ONE orb (GlassOrb). It stays centered and ambient until there
 * is real content (a conversation, or the first transcribed word), then drops to
 * the bottom. Hold Space to talk: realtime STT streams your words into the
 * center; on release the transcript is sent to Claude Code and the reply streams
 * below. Type + Enter does the same without voice.
 *
 * This file is deliberately thin — it wires hooks (useHomeChat, useVoiceCapture,
 * useRealtimeVoice, useHoldToTalk) to presentational components (Conversation,
 * Composer, VoiceStatus, LiveTranscript, Greeting). Behaviour lives in those.
 */
import { useCallback, useRef, useState } from 'react';
import { GlassOrb } from './orb/GlassOrb';
import { useVoiceCapture } from './voice/useVoiceCapture';
import { useRealtimeVoice } from './voice/useRealtimeVoice';
import { useHomeChat } from './hooks/useHomeChat';
import { useHoldToTalk } from './hooks/useHoldToTalk';
import { Conversation } from './components/Conversation';
import { Composer } from './components/Composer';
import { VoiceStatus } from './components/VoiceStatus';
import { LiveTranscript } from './components/SettledText';
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
  const [liveTranscript, setLiveTranscript] = useState('');

  // primary voice path: realtime STT (words stream in as you speak).
  const {
    levelRef: rtLevel,
    status: rtStatus,
    start: startRealtime,
    stop: stopRealtime,
  } = useRealtimeVoice((text) => setLiveTranscript(text));

  // fallback voice path: record whole clip, batch-transcribe on release.
  const {
    levelRef: batchLevel,
    start: startBatch,
    stop: stopBatch,
  } = useVoiceCapture();

  // which path is live this recording, so the orb reads the right level.
  const usingRealtimeRef = useRef(false);
  const micLevel = usingRealtimeRef.current ? rtLevel : batchLevel;
  const micStatus = rtStatus;

  // chat state derived from the real store.
  const chat = useHomeChat(listening, transcribing, liveTranscript);

  // hold Space → record → transcribe → send.
  useHoldToTalk({
    startRealtime,
    stopRealtime,
    startBatch,
    stopBatch,
    submit: chat.submit,
    busy: chat.storeBusy,
    onListeningChange: setListening,
    onTranscribingChange: setTranscribing,
    onVoiceError: setVoiceError,
    onLiveTranscriptReset: () => setLiveTranscript(''),
    setUsingRealtime: (v) => {
      usingRealtimeRef.current = v;
    },
  });

  const openMicSettings = useCallback(() => {
    void call(IPC.system.openMicSettings, {});
  }, []);

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

      {/* ambient greeting — hidden once in chat or while speaking */}
      {!chat.inChat && !listening && <Greeting />}

      {/* live transcript while speaking (nothing until the first word) */}
      {listening && liveTranscript && <LiveTranscript text={liveTranscript} />}

      {/* composer — hidden while recording / transcribing */}
      {!listening && !transcribing && (
        <Composer
          draft={chat.draft}
          onDraftChange={chat.setDraft}
          onSubmit={chat.submit}
          disabled={chat.storeBusy}
          voiceError={voiceError}
        />
      )}

      {/* scrollable conversation */}
      {chat.inChat && (
        <Conversation
          turns={chat.turns}
          currentSessionId={chat.currentSessionId}
          scrollRef={chat.scrollRef}
          liveExchangeRef={chat.liveExchangeRef}
          onScroll={chat.onScroll}
          recenter={chat.recenter}
        />
      )}

      {/* bottom voice status: transcribing spinner + mic-denied action */}
      <VoiceStatus
        transcribing={transcribing}
        micDenied={listening && micStatus === 'denied'}
        onOpenMicSettings={openMicSettings}
      />
    </div>
  );
}

export default ChatExperience;
