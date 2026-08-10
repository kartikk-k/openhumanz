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
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '../../routes';
import icon from './image.png'
import { GlassOrb, type OrbState } from './GlassOrb';

export function HomeScreen() {
  const navigate = useNavigate();
  const [orbState, setOrbState] = useState<OrbState>('idle');

  return (
    <div className="relative h-screen w-screen overflow-auto">
      {/* Draggable top strip (10px): hold-drag moves the frameless window,
          double-click zooms/maximizes it (native macOS behavior). */}
      <div className="draggable-region fixed inset-x-0 top-0 z-50 h-2.5" />

      {/* A small, unobtrusive way back to the app. Remove if you don't want it. */}
      <button
        type="button"
        onClick={() => navigate(ROUTES.chat)}
        className="absolute hidden right-4 top-4 z-20 rounded-md border border-zinc-200 bg-white/80 px-2.5 py-1 text-[12px] text-zinc-500 backdrop-blur transition hover:text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/80 dark:hover:text-zinc-200"
      >
        ← Back to app
      </button>

      {/* ─── Your experiment goes here ─────────────────────────────── */}

      <div className="relative z-10 flex h-full w-full flex-col items-center justify-center py-8">
          <GlassOrb state={orbState} size={340} />
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

          {/* State toggle to preview the reactive animation */}
          <div className="mt-6 flex gap-2 fixed bottom-2 left-2">
            {(['idle', 'speaking', 'thinking'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setOrbState(s)}
                className={`rounded-full px-2 py-0.5 text-xs capitalize transition ${
                  orbState === s
                    ? ' bg-white/20'
                    : 'bg-white/10'
                }`}
              >
                {/* {s} */}
              </button>
            ))}
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

        <div className="bg-black/20 rounded-3xl p-4 flex flex-col items-center max-w-xs gap-1">
          <img src={icon} className="size-8" />          
          <p className="mt-2 text-xs">Customer history</p>
          <p className="text-xs text-center opacity-60">Called about a declined card while travelling. Resolved and travel notice added.</p>


        </div>

      </div>

    </div>
  );
}

export default HomeScreen;
