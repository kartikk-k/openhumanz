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
import type { ChatBlock } from '../../../../shared/claudeTranscript.fold';
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
  /** live streaming turn's blocks (tool calls drive the activity chip). */
  liveBlocks: ChatBlock[];
  liveRunning: boolean;
  submit: (text: string) => void;
  /** pins the live thread's TOP into view (question stays put, answer streams
   *  below); called as content grows, unless the user scrolled up. */
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

  // Bring the live exchange (the newest Q+A screen) fully into view. Sections
  // are centered full-viewport, so we scroll it to the top of the scroller.
  // Only while the user hasn't scrolled up to read history (stickRef).
  const recenter = useCallback(() => {
    const el = scrollRef.current;
    const live = liveExchangeRef.current;
    if (!el || !live || !stickRef.current) return;
    el.scrollTo({ top: live.offsetTop, behavior: 'smooth' });
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    const live = liveExchangeRef.current;
    if (!el || !live) return;
    // considered "at the live screen" when its section fills the viewport.
    stickRef.current = Math.abs(el.scrollTop - live.offsetTop) < 240;
  }, []);

  // When a NEW user turn arrives (a new Q+A screen), snap to it. Resume sticking
  // and scroll the fresh section into view so the question streams in an empty
  // screen instead of overlapping the previous one.
  const lastUserId = [...turns].reverse().find((t) => t.role === 'user')?.id;
  useEffect(() => {
    stickRef.current = true;
    // let the new section mount, then snap to it (a couple of frames).
    const id = window.setTimeout(() => {
      const el = scrollRef.current;
      const live = liveExchangeRef.current;
      if (el && live) el.scrollTo({ top: live.offsetTop, behavior: 'smooth' });
    }, 50);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastUserId]);

  // send a real message to Claude Code via the chat store.
  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || storeBusy) return;
      stickRef.current = true;
      setDraft('');
      void sendChat(trimmed, 'home');
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
    liveBlocks: liveTurn?.blocks ?? [],
    liveRunning: !!liveTurn?.running,
    submit,
    recenter,
    onScroll,
    scrollRef,
    liveExchangeRef,
    draft,
    setDraft,
  };
}
