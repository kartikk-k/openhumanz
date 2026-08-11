/**
 * Home — a blank, full-window canvas.
 *
 * This screen renders OUTSIDE the app shell: no sidebar, no header, no chrome.
 * It hosts the ChatExperience (one orb, streaming text turns, hold-to-talk) plus
 * the ambient corner cards (Upcoming next, Customer history).
 *
 * Because it's outside AppShell, it connects the push channels itself via
 * useAppBootstrap — without that the chat store never hears the agent's reply.
 */
import { useAppBootstrap } from '../../store';
import { ChatExperience } from './ChatExperience';
import { UpcomingNext } from './components/ambient/UpcomingNext';
import { CustomerHistory } from './components/ambient/CustomerHistory';

export function HomeScreen() {
  useAppBootstrap();

  return (
    <div className="relative h-screen w-screen overflow-hidden text-white">
      {/* Draggable top strip (10px): hold-drag moves the frameless window,
          double-click zooms/maximizes it (native macOS behavior). */}
      <div className="draggable-region fixed inset-x-0 top-0 z-50 h-2.5" />

      {/* The chat/voice experience owns the center + orb. */}
      <ChatExperience />

      {/* Ambient corner cards (positions unchanged). */}
      <UpcomingNext />
      <CustomerHistory />
    </div>
  );
}

export default HomeScreen;
