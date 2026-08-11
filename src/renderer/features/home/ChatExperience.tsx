/**
 * ChatExperience — an exploration of the voice/chat flow, self-contained.
 *
 * The idea being explored (not a final design):
 *   - There is exactly ONE orb (GlassOrb). It never duplicates. It only changes
 *     state (idle / listening / thinking) and, occasionally, shape.
 *   - On landing there are no turns: the orb sits centered with a greeting and
 *     the "Ask me anything" input — the ambient/default state.
 *   - The first interaction (hold Space to speak) drops the orb to the bottom —
 *     an organic resting spot — and hides the greeting + input while listening.
 *   - The user's speech streams into the center, then the assistant's response
 *     streams below it; the view scrolls, and you can scroll up to read earlier
 *     turns.
 *   - A scenario dropdown (top-right) drives simulated conversations; it hides
 *     while a simulation is running and returns when it finishes.
 *
 * Everything text-related (word streaming, FLIP smoothing, resize) lives in
 * StreamingText. Everything orb-related lives in GlassOrb. This file is just the
 * conductor.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { GlassOrb, type OrbState } from './GlassOrb';
// Previous streaming text (kept for reference; superseded by AutoMergeText).
// import { StreamingText } from './StreamingText';
import { AutoMergeText } from './AutoMergeText';
import { SIZE_STYLES, layoutMergeText } from './lib/partition-merge-text';
import { sizeForCount, wrapWords } from './lib/timeline';
import { useVoiceCapture } from './useVoiceCapture';
import { call } from '../../lib/ipc';
import { IPC } from '../../../shared/ipc';
import { useChatStore } from '../../store';
import type {
  ChatBlock,
  ChatTurn,
} from '../../../shared/claudeTranscript.fold';
import type { LiveTurn } from '../chat/liveTurn';

/** Flatten a block list to plain text (text blocks only; skip tool/thinking). */
function blocksToText(blocks: ChatBlock[]): string {
  return blocks
    .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// The size AutoMergeText settles a fully-revealed text at, so the settled
// question that takes over hands off at the exact same size (no pop).
function settledSize(text: string) {
  return sizeForCount(text.trim().split(/\s+/).filter(Boolean).length);
}
function settledFont(text: string) {
  const style = SIZE_STYLES[settledSize(text)];
  return { fontSize: style.fontSize, lineHeight: style.lineHeight };
}

// Column width the chat text lives in.
const COLUMN_WIDTH = 'min(880px, 92vw)';

// The EXACT committed lines AutoMergeText shows for a fully-revealed text, so
// the settled layer that takes over is byte-identical:
//  - 3xl/xl: layoutMergeText's forced short-line split.
//  - base:   wrapWords' char-budget split (AutoMergeText's base path uses this,
//            rendering each as its OWN centered line — NOT a natural pixel wrap).
// Each returned line is rendered nowrap so the browser can't re-wrap it narrower
// than intended (the bug that produced the 7-line mess).
function settledLines(text: string) {
  if (settledSize(text) !== 'base') return layoutMergeText(text).lines;
  return wrapWords(text.trim().split(/\s+/).filter(Boolean)).map((line) =>
    line.join(' '),
  );
}

/**
 * SettledAnswer — a past assistant turn, rendered statically at the exact size
 * and line layout AutoMergeText settles at. No animation: past turns must not
 * re-stream when scrolled back into view.
 */
function SettledAnswer({ text }: { text: string }) {
  const font = settledFont(text);
  const lines = settledLines(text);
  const nowrap = settledSize(text) !== 'base';
  return (
    <div
      className="text-center font-medium tracking-tight text-white/95"
      style={{
        fontSize: font.fontSize,
        lineHeight: font.lineHeight,
        maxWidth: COLUMN_WIDTH,
      }}
    >
      {lines.map((line, i) => (
        <div
          // eslint-disable-next-line react/no-array-index-key
          key={i}
          style={{ whiteSpace: nowrap ? 'nowrap' : 'normal' }}
        >
          {line}
        </div>
      ))}
    </div>
  );
}

const SETTLED_COMPACT_PX = 19; // final compact size once answered
const COLLAPSE_MS = 520; // how long the asked→compact merge takes
// The big "asked" layer fades/blurs out FASTER and earlier than it scales, so
// it's gone before you register the shrink — otherwise watching it scale all
// the way down reads as a "zoom out". Exit is front-loaded (ease-out, short).
const ASKED_EXIT_MS = 300;

/**
 * SettledQuestion — the user question after it has finished streaming.
 *
 * When the answer arrives it must go from the big (possibly two-line) "asked"
 * layout to a small one-line compact header. Animating font-size reflows the
 * wrap discretely (two lines snap to one BEFORE shrinking) — the jarring step.
 *
 * Instead we cross-fade like AutoMergeText's line merge: two layers stacked and
 * centered — the big "asked" layout (kept at its own wrap the whole time) scales
 * DOWN + blurs + fades OUT, while the compact one-line layout blurs + fades IN.
 * Nothing reflows mid-flight, so the two lines organically dissolve into one.
 */
function SettledQuestion({
  text,
  answered,
  askedFont,
  onGrow,
}: {
  text: string;
  answered: boolean;
  askedFont: { fontSize: string; lineHeight: string };
  onGrow?: () => void;
}) {
  const grow = useRef(onGrow);
  grow.current = onGrow;

  const bigRef = useRef<HTMLDivElement>(null);
  const compactRef = useRef<HTMLParagraphElement>(null);
  // measured heights of each layout; the container animates BETWEEN them so the
  // reposition (block shrinking) happens ON THE SAME CLOCK as the crossfade,
  // instead of an instant position jump followed by a separate fade.
  const [bigH, setBigH] = useState<number | null>(null);
  const [compactH, setCompactH] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (bigRef.current) setBigH(bigRef.current.offsetHeight);
    if (compactRef.current) setCompactH(compactRef.current.offsetHeight);
  }, [text, askedFont.fontSize]);

  // fire onGrow across the whole collapse so the parent keeps it centered as the
  // block height animates (not just once at the start).
  useEffect(() => {
    grow.current?.();
    if (!answered) return undefined;
    const id = window.setInterval(() => grow.current?.(), 60);
    const stop = window.setTimeout(() => window.clearInterval(id), COLLAPSE_MS);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(stop);
    };
  }, [answered]);

  // AutoMergeText's committed lines (see settledLines): each rendered on its own
  // line, nowrap, so the layout is byte-identical to the last streamed frame.
  const askedLines = settledLines(text);

  const height = answered ? compactH : bigH;

  return (
    <div
      className="relative flex w-full items-center justify-center text-center font-medium tracking-tight text-white/45"
      style={{
        // height animates big→compact together with the crossfade → one motion.
        height: height ?? undefined,
        transition: `height ${COLLAPSE_MS}ms cubic-bezier(0.22,1,0.36,1)`,
        willChange: 'height',
      }}
    >
      {/* big "asked" layout — its own committed line split; blurs+fades out.
          Kept absolute+centered the whole time so it never affects flow; the
          container height (above) is what moves. */}
      <div
        ref={bigRef}
        aria-hidden={answered}
        className="absolute left-1/2 top-1/2"
        style={{
          margin: 0,
          fontSize: askedFont.fontSize,
          lineHeight: askedFont.lineHeight,
          transform: answered
            ? 'translate(-50%,-50%) scale(0.9)'
            : 'translate(-50%,-50%) scale(1)',
          transformOrigin: 'center center',
          filter: answered ? 'blur(10px)' : 'blur(0)',
          opacity: answered ? 0 : 1,
          transition:
            `transform ${COLLAPSE_MS}ms cubic-bezier(0.22,1,0.36,1), ` +
            `filter ${ASKED_EXIT_MS}ms cubic-bezier(0.4,0,1,1), ` +
            `opacity ${ASKED_EXIT_MS}ms cubic-bezier(0.4,0,1,1)`,
          willChange: 'transform, filter, opacity',
          // cap at the column but SIZE TO CONTENT, so each pre-split line sits at
          // its natural width and the block stays centered — the nowrap lines
          // below can't be re-wrapped narrower.
          maxWidth: COLUMN_WIDTH,
          width: 'max-content',
        }}
      >
        {/* each committed line on its OWN line, nowrap — identical to the last
            streamed frame, whether short (layoutMergeText) or long (wrapWords). */}
        {askedLines.map((line, i) => (
          <div
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            style={{ whiteSpace: 'nowrap' }}
          >
            {line}
          </div>
        ))}
      </div>

      {/* compact one-line layout — blurs+fades in, centered */}
      <p
        ref={compactRef}
        aria-hidden={!answered}
        className="absolute left-1/2 top-1/2"
        style={{
          margin: 0,
          fontSize: `${SETTLED_COMPACT_PX}px`,
          lineHeight: 1.35,
          // wrap into a tidy compact block; a long question at 19px must NOT be
          // forced onto one line (that overflowed off-screen).
          maxWidth: '46ch',
          width: 'max-content',
          whiteSpace: 'normal',
          textWrap: 'balance',
          transform: answered
            ? 'translate(-50%,-50%) scale(1)'
            : 'translate(-50%,-50%) scale(1.12)',
          transformOrigin: 'center center',
          filter: answered ? 'blur(0)' : 'blur(8px)',
          opacity: answered ? 1 : 0,
          transition:
            `transform ${COLLAPSE_MS}ms cubic-bezier(0.22,1,0.36,1), ` +
            `filter ${COLLAPSE_MS}ms cubic-bezier(0.22,1,0.36,1), ` +
            `opacity ${COLLAPSE_MS}ms ease`,
          willChange: 'transform, filter, opacity',
          pointerEvents: answered ? undefined : 'none',
        }}
      >
        {text}
      </p>
    </div>
  );
}

type Role = 'user' | 'assistant';
interface Turn {
  id: string;
  role: Role;
  text: string;
  /** stream the text in (true) or show it settled instantly (past turns). */
  animate: boolean;
  done: boolean;
  /** optional shape preset for assistant turns (question/approval/etc.) */
  shape?: string;
}

/**
 * Build the flat Turn[] the UI renders from the real chat store:
 *   - past turns come from the durable transcript (shown settled, no re-stream),
 *   - the just-asked question comes from `pendingUserMessage` (optimistic),
 *   - the streaming answer comes from `liveTurn` (the only turn that animates).
 * The store clears pending/live once the durable transcript carries them, so
 * there's no double-render at the handoff.
 */
function buildTurns(
  transcriptTurns: ChatTurn[],
  pendingUserMessage: string | null,
  liveTurn: LiveTurn | null,
): Turn[] {
  const turns: Turn[] = [];

  for (const t of transcriptTurns) {
    const text = blocksToText(t.message.blocks);
    if (!text) continue; // skip tool-only / empty turns for this text-only view
    turns.push({
      id: t.id,
      role: t.message.role,
      text,
      animate: false,
      done: true,
    });
  }

  if (pendingUserMessage) {
    turns.push({
      id: 'pending-user',
      role: 'user',
      text: pendingUserMessage,
      animate: false,
      done: true,
    });
  }

  if (liveTurn) {
    const text = blocksToText(liveTurn.blocks);
    if (text) {
      turns.push({
        id: 'live-assistant',
        role: 'assistant',
        text,
        animate: true,
        done: !liveTurn.running,
      });
    }
  }

  return turns;
}

// orb rests centered when ambient, drops toward the BOTTOM once in a chat.
// uCenter.y is in WebGL UV space: 1 = top of screen, 0 = bottom. So a SMALLER
// y sits lower. Ambient ~middle, chat ~lower third.
const CENTER_AMBIENT: [number, number] = [0.5, 0.55];
const CENTER_CHAT: [number, number] = [0.5, 0.18];

/**
 * Group a flat turn list into exchanges. Each user turn opens a new exchange;
 * assistant turns attach to the current one. This lets each Q+A pair own a full
 * viewport height so scrolling steps cleanly between conversations.
 */
function groupExchanges(turns: Turn[]): Turn[][] {
  const groups: Turn[][] = [];
  for (const turn of turns) {
    if (turn.role === 'user' || groups.length === 0) {
      groups.push([turn]);
    } else {
      groups[groups.length - 1].push(turn);
    }
  }
  return groups;
}

/* ── simulated scenarios — SUPERSEDED by real chat (kept for reference; this
   whole block is disabled now that ChatExperience streams the real agent). ──
interface Scenario {
  label: string;
  run: (api: ScenarioApi) => Promise<void>;
}
interface ScenarioApi {
  user: (text: string) => Promise<void>;
  assistant: (text: string, shape?: string) => Promise<void>;
  think: (ms: number) => Promise<void>;
  cancelled: () => boolean;
}

const SCENARIOS: Record<string, Scenario> = {
  voice: {
    label: 'Ambient voice',
    async run({ user, assistant, think }) {
      await user('what did I miss in email this morning');
      await think(1500);
      await assistant(
        'Nine came in. Two actually need you — the vendor contract and a reschedule from Aisha.',
      );
    },
  },
  short: {
    label: 'Short answer',
    async run({ user, assistant, think }) {
      await user('what time is my dentist');
      await think(900);
      await assistant('2 PM today.');
    },
  },
  long: {
    label: 'Long answer',
    async run({ user, assistant, think }) {
      await user('summarise the vendor contract thread');
      await think(1400);
      await assistant(
        'Three rounds since Tuesday. They accepted the sixty-day payment terms but pushed back on the liability cap, proposing two times annual fees instead of three. Legal has not weighed in yet, and Priya asked for your call before Thursday.',
      );
    },
  },
  approval: {
    label: 'Approval',
    async run({ user, assistant, think }) {
      await user('reply to Aisha and move the review to Friday');
      await think(1200);
      await assistant(
        'Drafted the reply and the reschedule. I need your permission before sending — first time this conversation.',
        'Gem',
      );
    },
  },
  schedule: {
    label: 'Schedule',
    async run({ user, assistant, think }) {
      await user("what's my day look like");
      await think(1100);
      await assistant(
        'Light until two, then it tightens: standup at nine-thirty, Aisha’s design doc at eleven, dentist at two, gym at five.',
        'Cog',
      );
    },
  },
  question: {
    label: 'Asks you back',
    async run({ user, assistant, think }) {
      await user('book me a flight to Berlin next week');
      await think(1300);
      await assistant(
        'Which day works — Tuesday or Wednesday? And morning or evening departure?',
        'Spiral',
      );
    },
  },
  // a deliberately long, multi-line QUESTION so the question-side shrink/merge
  // is visible before any answer arrives.
  longQuestion: {
    label: 'Long question',
    async run({ user, assistant, think }) {
      await user(
        'can you pull together everything from the vendor contract thread this week, including where legal landed on the liability cap, what Priya still needs from me before Thursday, and whether the sixty-day payment terms are actually final now',
      );
      await think(1600);
      await assistant(
        'Yes. Legal signed off on two times annual fees for the cap, Priya needs your go-ahead on clause four, and the sixty-day terms are locked.',
      );
    },
  },
};

const SCENARIO_KEYS = Object.keys(SCENARIOS);
── end disabled scenarios ── */

export function ChatExperience() {
  // ── real chat store: past transcript + optimistic pending + live stream ──
  const initChat = useChatStore((s) => s.init);
  const transcript = useChatStore((s) => s.transcript);
  const pendingUserMessage = useChatStore((s) => s.pendingUserMessage);
  const liveTurn = useChatStore((s) => s.liveTurn);
  const storeBusy = useChatStore((s) => s.busy);
  const sendChat = useChatStore((s) => s.send);

  const [orbState, setOrbState] = useState<OrbState>('idle');
  const [shape] = useState<string | undefined>(undefined);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  // hold-to-talk recording + live level for the orb.
  const {
    levelRef: micLevel,
    status: micStatus,
    start: startRecording,
    stop: stopRecording,
  } = useVoiceCapture();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // load the current session's transcript (and keep it live via the global
  // push subscriptions wired in the app bootstrap) when this screen mounts.
  useEffect(() => {
    void initChat();
  }, [initChat]);

  const turns = buildTurns(
    transcript?.turns ?? [],
    pendingUserMessage,
    liveTurn,
  );
  const inChat = turns.length > 0 || storeBusy || listening || transcribing;

  // drive the orb from the real chat state: react to voice while recording,
  // think while transcribing or while the turn is running with no text yet,
  // speak once the answer is streaming, idle when done.
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

  // the newest (live) exchange <section>, so we can bring its TOP into view
  const liveExchangeRef = useRef<HTMLElement>(null);

  // keep the live exchange's top pinned near the top of the viewport, unless
  // the user scrolled up. Because the exchange is top-anchored, streaming the
  // response below the question never pushes the question — so once the top is
  // placed we mostly leave it; we only re-pin when a NEW exchange starts.
  const recenter = useCallback(() => {
    const el = scrollRef.current;
    const live = liveExchangeRef.current;
    if (!el || !live || !stickRef.current) return;
    el.scrollTo({ top: live.offsetTop, behavior: 'smooth' });
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  };

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

  // ── hold Space → record; release → transcribe (OpenAI) → send to chat. ──
  // Latest values via refs so the key listeners can stay mounted once and never
  // capture stale state.
  const listeningRef = useRef(false);
  const busyRef = useRef(storeBusy);
  busyRef.current = storeBusy;
  const startRef = useRef(startRecording);
  const stopRef = useRef(stopRecording);
  const submitRef = useRef(submit);
  startRef.current = startRecording;
  stopRef.current = stopRecording;
  submitRef.current = submit;

  useEffect(() => {
    const isTyping = (el: EventTarget | null) => {
      const t = el as HTMLElement | null;
      return (
        !!t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.isContentEditable)
      );
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isTyping(e.target)) return;
      if (busyRef.current || listeningRef.current) return;
      e.preventDefault();
      listeningRef.current = true;
      setVoiceError(null);
      setListening(true);
      void startRef.current();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !listeningRef.current) return;
      listeningRef.current = false;
      setListening(false);
      void (async () => {
        const clip = await stopRef.current();
        if (!clip) return; // nothing captured (too short / no mic)
        setTranscribing(true);
        try {
          const { text } = await call(IPC.voice.transcribe, {
            audioBase64: clip.base64,
            mimeType: clip.mimeType,
          });
          if (text) submitRef.current(text);
          else setVoiceError("Didn't catch that — try again.");
        } catch (cause) {
          setVoiceError(
            cause instanceof Error ? cause.message : 'Transcription failed.',
          );
        } finally {
          setTranscribing(false);
        }
      })();
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* the single orb — centered when ambient, dropped to the bottom in chat */}
      <GlassOrb
        state={orbState}
        preset={shape}
        size={inChat ? 150 : 300}
        center={inChat ? CENTER_CHAT : CENTER_AMBIENT}
        levelRef={listening ? micLevel : undefined}
        controls={false}
      />

      {/* Mock scenario dropdown — kept (hidden) for reference now that this is
          real chat. To bring it back, restore the SCENARIOS wiring in the body.
      {!storeBusy && (
        <div className="fixed right-4 top-4 z-30">
          … scenario buttons …
        </div>
      )} */}

      {/* new-chat, top-right — starts a fresh session */}
      {!storeBusy && !listening && turns.length > 0 && (
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

      {/* ── ambient: greeting, centered above the orb ── */}
      {!inChat && (
        <div className="pointer-events-none fixed inset-0 z-20 flex flex-col items-center justify-center">
          <h1 className="pointer-events-auto mb-[80vh] text-center text-3xl font-light text-white/90">
            Good Morning! <br />
            How can I help you today?
          </h1>
        </div>
      )}

      {/* ── composer: fixed at the bottom in both ambient and chat modes.
          Enter sends a real message to Claude Code; hold Space to talk. Hidden
          while actively listening so the orb has the stage. ── */}
      {!listening && !transcribing && (
        <div className="pointer-events-none fixed bottom-10 left-1/2 z-30 -translate-x-1/2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit(draft);
              }
            }}
            disabled={storeBusy}
            placeholder={storeBusy ? 'Thinking…' : 'Ask me anything…'}
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
      )}

      {/* ── chat: scrollable stream of exchanges ──
          Each exchange (a user question + its assistant reply) fills at least a
          full viewport height and centers its content. The leftover space
          becomes clean separation, so scrolling steps cleanly from one
          conversation to the next instead of stacking several per screen. */}
      {inChat && (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="absolute inset-0 z-20 overflow-y-auto"
          style={{ scrollbarWidth: 'none', scrollSnapType: 'y proximity' }}
        >
          {groupExchanges(turns).map((exchange, gi, groups) => (
            <section
              key={exchange[0].id}
              ref={gi === groups.length - 1 ? liveExchangeRef : undefined}
              // top-anchored (not centered): the question stays put once asked
              // and the response streams BELOW it — so adding the response never
              // shoves the question up. Each exchange still owns a full viewport
              // so scrolling steps cleanly between conversations.
              className="flex min-h-screen flex-col items-center justify-start gap-6 px-6 pb-[24vh] pt-[22vh]"
              style={{ scrollSnapAlign: 'start' }}
            >
              {exchange.map((turn) => {
                const hasAnswer = exchange.some((x) => x.role === 'assistant');
                const isUser = turn.role === 'user';

                // width comes from the viewport, not a fixed px value, so the
                // merge/wrap calculation reacts to window size.
                const colClass =
                  'flex w-full max-w-[min(880px,92vw)] flex-col items-center';

                // The user question settles into a plain <p> once it has finished
                // streaming (turn.done). We render THAT SAME <p> both before and
                // after the answer arrives, and only transition its font-size /
                // opacity when `hasAnswer` flips — so big→small is a smooth CSS
                // tween on one stable element instead of a hard swap between two
                // different renderers (which is what made it feel instant).
                //
                // While still streaming, AutoMergeText owns it (word/merge
                // animation). At stream-end AutoMergeText is already showing its
                // static committed lines at the same size/position, so handing
                // off to the settled <p> is visually seamless.
                if (isUser && turn.done) {
                  // asked size = exactly where AutoMergeText left the stream, so
                  // the handoff doesn't pop; SettledQuestion then merges it down
                  // to the compact header via blur+scale crossfade (no reflow).
                  return (
                    <div key={turn.id} className={colClass}>
                      <SettledQuestion
                        text={turn.text}
                        answered={hasAnswer}
                        askedFont={settledFont(turn.text)}
                        onGrow={recenter}
                      />
                    </div>
                  );
                }

                // Past turns (from the durable transcript) render settled,
                // NOT re-streamed — AutoMergeText always plays from the start,
                // so an already-finished turn would replay on every mount/scroll.
                if (!turn.animate) {
                  return (
                    <div
                      key={turn.id}
                      className={`${colClass} ${!isUser ? 'opacity-45' : ''}`}
                    >
                      <SettledAnswer text={turn.text} />
                    </div>
                  );
                }

                // The live streaming turn (assistant answer, or a question still
                // being streamed) uses the full word/merge animation.
                return (
                  <div
                    key={turn.id}
                    className={`${colClass} ${
                      turn.done && !isUser
                        ? 'opacity-45 transition-opacity duration-500'
                        : ''
                    }`}
                  >
                    <AutoMergeText
                      text={turn.text}
                      className={isUser ? 'text-white/45' : 'text-white/95'}
                      onGrow={recenter}
                    />
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}

      {/* voice status at the bottom while recording / transcribing */}
      {(listening || transcribing) && (
        <div className="fixed bottom-8 left-1/2 z-30 -translate-x-1/2 text-center">
          <p className="text-xs text-white/50">
            {transcribing ? 'Transcribing…' : 'Listening…'}
          </p>
          {listening && micStatus === 'denied' && (
            <button
              type="button"
              onClick={() => {
                void call(IPC.system.openMicSettings, {});
              }}
              className="mt-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs text-white/70 hover:text-white"
            >
              Microphone blocked — Open Settings
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default ChatExperience;
