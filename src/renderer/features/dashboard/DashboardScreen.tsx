/**
 * Dashboard — a full-window overview canvas.
 *
 * A sibling to Home: same full-window, chrome-free shell (no sidebar, no
 * header, draggable top strip). Instead of the chat orb it lays out an ambient
 * overview — upcoming events, reminders, messages, running & completed tasks,
 * workflows.
 *
 * Deliberately boxless: no cards, no borders, no fills. Structure comes from
 * quiet dimmed labels, typography and whitespace alone, so the whole thing
 * reads as one calm, seamless surface. Sections flow into loose columns.
 *
 * This is a self-contained PROTOTYPE. It reads only from `./data.ts` (dummy,
 * hardcoded) and is NOT wired to any store, IPC channel, or the chat
 * experience. It exists to explore the UI.
 */
import { UpcomingEventsCard } from './components/UpcomingEventsCard';
import { RemindersCard } from './components/RemindersCard';
import { MessagesCard } from './components/MessagesCard';
import { RunningTasksCard } from './components/RunningTasksCard';
import { CompletedTasksCard } from './components/CompletedTasksCard';
import { WorkflowsCard } from './components/WorkflowsCard';

export function DashboardScreen() {
  return (
    <div className="relative h-screen w-screen overflow-hidden text-white">
      {/* Draggable top strip (10px): hold-drag moves the frameless window,
          double-click zooms/maximizes it (native macOS behavior). */}
      <div className="draggable-region fixed inset-x-0 top-0 z-50 h-2.5" />

      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-5xl px-10 pb-16 pt-14">
          {/* Greeting — echoes the Home canvas's tone. */}
          <header className="mb-12">
            <h1 className="text-3xl font-light text-white/90">Good Morning!</h1>
            <p className="mt-1.5 text-sm text-white/35">
              Here&apos;s everything on your plate today.
            </p>
          </header>

          {/* Loose columns via CSS multi-column: sections flow top-to-bottom,
              wrapping into the next column. No grid lines, no boxes — just
              whitespace between groups. `break-inside-avoid` keeps a section
              whole. */}
          <div className="columns-1 gap-x-16 md:columns-2 xl:columns-3">
            <div className="break-inside-avoid">
              <UpcomingEventsCard />
            </div>
            <div className="break-inside-avoid">
              <MessagesCard />
            </div>
            <div className="break-inside-avoid">
              <RunningTasksCard />
            </div>
            <div className="break-inside-avoid">
              <RemindersCard />
            </div>
            <div className="break-inside-avoid">
              <WorkflowsCard />
            </div>
            <div className="break-inside-avoid">
              <CompletedTasksCard />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DashboardScreen;
