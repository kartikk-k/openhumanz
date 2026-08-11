/**
 * useHomeChat — the home screen's chat state, derived from the real chat store.
 *
 * Reads the transcript / optimistic pending message / live streaming turn from
 * the store, folds them into the flat Turn[] the UI renders, derives the layout
 * flags (hasContent / inChat / orbDropped), drives the orb state, and exposes
 * `submit` (send a real message) + `recenter` (keep the live exchange pinned).
 *
 * Owns the scroll refs so the conductor stays thin.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '../../../store';
import type { OrbState } from '../orb/GlassOrb';
import { buildTurns, type Turn } from '../lib/turns';

export interface HomeChat {
  turns: Turn[];
  currentSessionId: string | null;
  storeBusy: boolean;
  /** real content on screen (conversation / running turn / transcribed words). */
  hasContent: boolean;
  /** composer/greeting gate — also true while listening. */
  inChat: boolean;
  /** the orb drops to the bottom only once there is content. */
  orbDropped: boolean;
  orbState: OrbState;
  submit: (text: string) => void;
  recenter: () => void;
  onScroll: () => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  liveExchangeRef: React.RefObject<HTMLElement | null>;
  draft: string;
  setDraft: (v: string) => void;
}

/**
 * @param listening    true while the mic is recording (from the voice hook)
 * @param transcribing true while a transcription is in flight
 * @param liveTranscript the realtime transcript-so-far (drives content flags)
 */
export function useHomeChat(
  listening: boolean,
  transcribing: boolean,
  liveTranscript: string,
): HomeChat {
  const initChat = useChatStore((s) => s.init);
  const transcript = useChatStore((s) => s.transcript);
  const pendingUserMessage = useChatStore((s) => s.pendingUserMessage);
  const liveTurn = useChatStore((s) => s.liveTurn);
  const storeBusy = useChatStore((s) => s.busy);
  const sendChat = useChatStore((s) => s.send);
  const currentSessionId = useChatStore((s) => s.currentSessionId);

  const [orbState, setOrbState] = useState<OrbState>('idle');
  const [draft, setDraft] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const liveExchangeRef = useRef<HTMLElement>(null);
  const stickRef = useRef(true);

  // load the current session's transcript on mount (kept live via the global
  // push subscriptions the screen connects through useAppBootstrap).
  useEffect(() => {
    void initChat();
  }, [initChat]);

  const turns = buildTurns(
    transcript?.turns ?? [],
    pendingUserMessage,
    liveTurn,
  );

  // real content on screen — as opposed to just listening in silence.
  const hasContent =
    turns.length > 0 ||
    storeBusy ||
    transcribing ||
    liveTranscript.trim().length > 0;
  const inChat = hasContent || listening;
  const orbDropped = hasContent;

  // drive the orb: react to voice while recording, think while transcribing or
  // while the turn is running with no text yet, speak once the answer streams,
  // idle when done.
  useEffect(() => {
    if (listening) {
      setOrbState('speaking');
      return;
    }
    if (transcribing) {
      setOrbState('thinking');
      return;
    }
    if (storeBusy) {
      const answering = !!liveTurn && liveTurn.blocks.length > 0;
      setOrbState(answering ? 'speaking' : 'thinking');
      return;
    }
    setOrbState('idle');
  }, [storeBusy, liveTurn, listening, transcribing]);

  // keep the live exchange's top pinned near the top of the viewport, unless
  // the user scrolled up.
  const recenter = useCallback(() => {
    const el = scrollRef.current;
    const live = liveExchangeRef.current;
    if (!el || !live || !stickRef.current) return;
    el.scrollTo({ top: live.offsetTop, behavior: 'smooth' });
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  }, []);

  // send a real message to Claude Code via the chat store.
  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || storeBusy) return;
      stickRef.current = true;
      setDraft('');
      void sendChat(trimmed);
    },
    [sendChat, storeBusy],
  );

  return {
    turns,
    currentSessionId,
    storeBusy,
    hasContent,
    inChat,
    orbDropped,
    orbState,
    submit,
    recenter,
    onScroll,
    scrollRef,
    liveExchangeRef,
    draft,
    setDraft,
  };
}
