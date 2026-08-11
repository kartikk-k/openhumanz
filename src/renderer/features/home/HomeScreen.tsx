/**
 * Home — a blank, full-window canvas.
 *
 * This screen renders OUTSIDE the app shell: no sidebar, no header, no chrome.
 * It hosts the ChatExperience exploration (one orb, streaming text turns, a
 * scenario dropdown) plus the ambient corner cards (Upcoming, Customer
 * history). Hold Space to simulate voice.
 */
import { useAppBootstrap } from '../../store';
import { ChatExperience } from './ChatExperience';
import icon from './image.png';

export function HomeScreen() {
  // Home renders OUTSIDE AppShell, so it must connect the push channels itself
  // (chat:updated / chat:stream live here). Without this the chat store never
  // hears the agent's reply — the turn runs on the backend but the answer never
  // streams in and "Thinking…" never clears.
  useAppBootstrap();

  return (
    <div className="relative h-screen w-screen overflow-hidden text-white">
      {/* Draggable top strip (10px): hold-drag moves the frameless window,
          double-click zooms/maximizes it (native macOS behavior). */}
      <div className="draggable-region fixed inset-x-0 top-0 z-50 h-2.5" />

      {/* The chat/voice experience owns the center + orb. */}
      <ChatExperience />

      {/* ── Ambient: Upcoming next (top-left) ── */}
      <div className="pointer-events-none fixed left-2 top-4 z-10 text-xs">
        <p className="px-2 opacity-30">Upcoming next:</p>
        <div className="pointer-events-auto mt-2 space-y-2">
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

      {/* ── Ambient: Customer history card (bottom-right) ── */}
      <div className="fixed bottom-2 right-2 z-10 flex flex-row gap-4">
        <div className="flex max-w-xs flex-col items-center gap-1 rounded-3xl bg-black/20 p-4">
          <img src={icon} className="size-8" alt="message icon" />
          <p className="mt-2 text-xs">Customer history</p>
          <p className="text-center text-xs opacity-60">
            Called about a declined card while travelling. Resolved and travel
            notice added
          </p>
        </div>
      </div>
    </div>
  );
}

export default HomeScreen;
