/**
 * Home — a blank, full-window canvas.
 *
 * This screen renders OUTSIDE the app shell: no sidebar, no header, no chrome.
 * It's a scratch space to try things out visually. Put whatever you're
 * experimenting with inside the div below.
 *
 * To get back to the rest of the app, navigate anywhere else (the routes still
 * exist) — e.g. add a link, or use the corner button below.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '../../routes';
import icon from './image.png';
import { GlassOrb, GALLERY_NAMES, type OrbState } from './GlassOrb';
import { useMicLevel, type MicStatus } from './useMicLevel';
import { call } from '../../lib/ipc';
import { IPC } from '../../../shared/ipc';

export function HomeScreen() {
  const navigate = useNavigate();
  const [orbState, setOrbState] = useState<OrbState>('idle');
  // when set, overrides the state look with an exploration preset
  const [preset, setPreset] = useState<string | undefined>(undefined);

  // Hold Space to listen: opens the mic and drives the orb from real volume.
  const [listening, setListening] = useState(false);
  const { levelRef: micLevel, status: micStatus } = useMicLevel(listening);
  // timer for the brief "thinking" beat after releasing Space
  const thinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) => {
      const t = el as HTMLElement | null;
      if (!t) return false;
      const tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
    };
    const clearThink = () => {
      if (thinkTimerRef.current) {
        clearTimeout(thinkTimerRef.current);
        thinkTimerRef.current = null;
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      if (isTypingTarget(e.target)) return; // don't hijack Space while typing
      e.preventDefault();
      clearThink(); // grabbing the mic again cancels a pending think->idle
      setListening(true);
      setOrbState('speaking');
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      setListening(false);
      // brief "thinking" beat, then settle back to idle
      setOrbState('thinking');
      clearThink();
      thinkTimerRef.current = setTimeout(() => {
        setOrbState('idle');
        thinkTimerRef.current = null;
      }, 2000);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      clearThink();
    };
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-auto">
      {/* Draggable top strip (10px): hold-drag moves the frameless window,
          double-click zooms/maximizes it (native macOS behavior). */}
      <div className="draggable-region fixed inset-x-0 top-0 z-50 h-2.5" />

      {/* A small, unobtrusive way back to the app. Remove if you don't want it. */}
      <button
        type="button"
        onClick={() => navigate(ROUTES.chat)}
        className="absolute right-4 top-4 z-20 hidden rounded-md border border-zinc-200 bg-white/80 px-2.5 py-1 text-[12px] text-zinc-500 backdrop-blur transition hover:text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/80 dark:hover:text-zinc-200"
      >
        ← Back to app
      </button>

      {/* ─── Your experiment goes here ─────────────────────────────── */}

      <div className="relative z-10 flex h-full w-full flex-col items-center justify-center py-8">
        <GlassOrb
          state={orbState}
          preset={preset}
          size={340}
          levelRef={listening ? micLevel : undefined}
        />
        <div className="flex flex-1 flex-col items-center">
          {/* Voice-reactive glass orb — fullscreen transparent canvas, orb
              drawn centered at a fixed pixel size so its glow blends cleanly.
              It renders as a fixed, centered background layer. */}

          {/* Spacer so the heading clears the centered orb above it. */}
          {/* <div style={{ height: 300 }} /> */}

          <h1 className="text-center text-2xl font-light">
            Good Morning! <br />
            How can I help you today?
          </h1>

          {/* Mic / listening status, small text below the orb */}
          <MicHint status={micStatus} listening={listening} />

          {/* State toggle to preview the reactive animation */}
          <div className="fixed bottom-2 left-2 mt-6 flex gap-2">
            {(['idle', 'speaking', 'thinking', 'error'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setOrbState(s)}
                className={`rounded-full px-2 py-0.5 text-xs capitalize transition ${
                  orbState === s ? 'bg-white/20' : 'bg-white/10'
                }`}
              >
                {/* {s} */}
              </button>
            ))}
          </div>

          {/* Shape: minimal dropdown. Overrides the state silhouette while set. */}
          <div className="fixed bottom-5 left-0">
            <select
              value={preset ?? ''}
              onChange={(e) => setPreset(e.target.value || undefined)}
              className="rounded-full bg-white/10 px-3 py-1 text-xs text-white/80 outline-none backdrop-blur transition hover:bg-white/15"
            >
              <option value="">Default shape</option>
              {GALLERY_NAMES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <input
            type="text"
            placeholder="Ask me anything..."
            className="h-12 w-full min-w-[350px] rounded-full border border-white/20 bg-white/20 px-4 outline-none placeholder:text-white/50"
          />
        </div>
      </div>

      <div className="fixed bottom-4 right-4 flex flex-row gap-4">
        <div className="flex max-w-xs flex-col items-center gap-1 rounded-3xl bg-black/20 p-4">
          <img src={icon} className="size-8" alt="message icon" />
          <p className="mt-2 text-xs">Customer history</p>
          <p className="text-center text-xs opacity-60">
            Called about a declined card while travelling. Resolved and travel
            notice added
          </p>
        </div>
      </div>

      <div className="fixed left-2 top-4 z-10 text-xs">
        <p className="px-2 opacity-30">Upcoming next:</p>
        <div className="mt-2 space-y-2">
          <div className="rounded-xl bg-white/10 p-2 duration-300 hover:bg-white/15">
            <p className="text-[11px] opacity-60">9:30 AM (in 5 mins)</p>
            <p className="opacity-80">Standup with core team</p>
          </div>

          <div className="rounded-xl bg-white/10 p-2 duration-300 hover:bg-white/15">
            <p className="text-[11px] opacity-60">12:00 PM (in 2 hours)</p>
            <p className="opacity-80">Review Aisha&apos;s design doc</p>
          </div>
        </div>
      </div>
    </div>
  );
}

const ERROR_STATUSES: MicStatus[] = ['denied', 'nodevice', 'error'];

/** Small status line under the orb: prompts to hold Space, or shows mic errors.
 *  Error states linger for a few seconds after releasing Space so they can be
 *  read and acted on (the "Open Settings" button). */
function MicHint({
  status,
  listening,
}: {
  status: MicStatus;
  listening: boolean;
}) {
  // A sticky error that survives releasing Space, cleared by a timer.
  const [stickyError, setStickyError] = useState<MicStatus | null>(null);

  useEffect(() => {
    if (ERROR_STATUSES.includes(status)) {
      setStickyError(status);
      const id = setTimeout(() => setStickyError(null), 5000);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [status]);

  // While actively listening, show the live status; otherwise fall back to the
  // sticky error (if any) so a denied/error message stays visible ~5s.
  const shown: MicStatus | null = listening ? status : stickyError;

  let text = 'Hold Space to talk';
  let tone = 'text-white/40';
  let denied = false;

  if (shown === 'requesting') {
    text = 'Requesting microphone…';
    tone = 'text-white/60';
  } else if (shown === 'listening') {
    text = 'Listening…';
    tone = 'text-white/70';
  } else if (shown === 'denied') {
    text = 'Microphone access denied';
    tone = 'text-red-400/90';
    denied = true;
  } else if (shown === 'nodevice') {
    text = 'No microphone found';
    tone = 'text-red-400/90';
  } else if (shown === 'error') {
    text = 'Could not access the microphone';
    tone = 'text-red-400/90';
  }

  const openSettings = () => {
    void call(IPC.system.openMicSettings, {});
  };

  return (
    <div className="mt-4 flex max-w-xs flex-col items-center gap-2">
      <p className={`text-center text-xs transition ${tone}`}>{text}</p>
      {denied && (
        <button
          type="button"
          onClick={openSettings}
          className="rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs text-white/80 transition hover:bg-white/15"
        >
          Open Microphone Settings
        </button>
      )}
    </div>
  );
}

export default HomeScreen;
