/**
 * MessageList — a plain, flowing chat transcript for the dark home screen.
 *
 * Replaces the earlier snap-scroll / per-exchange viewport layout with an
 * ordinary vertically-scrolling message list: user turns are right-aligned
 * bubbles, assistant turns are left-aligned prose (rendered via
 * {@link HomeAssistantBlocks}, no background), and any pending approvals for the
 * current session hang off the end via {@link HomeApprovals}.
 *
 * Auto-scroll behaviour: the list "sticks" to the bottom so the newest message
 * stays in view as content streams in. If the user scrolls up to read history,
 * sticking pauses; it resumes once they scroll back near the bottom. Stickiness
 * is tracked in a ref (not state) so it never triggers a re-render, and the jump
 * to the bottom runs in a layout effect keyed on a cheap content signature so it
 * fires synchronously before paint (no visible flicker).
 */
import { useLayoutEffect, useRef } from 'react';
import type { Turn } from '../lib/turns';
import { HomeAssistantBlocks } from './HomeAssistantBlocks';
import { HomeApprovals } from './HomeApprovalCard';

/** Distance (px) from the bottom within which we consider the list "stuck". */
const STICK_THRESHOLD_PX = 120;

export function MessageList({
  turns,
  currentSessionId,
  scrollRef,
}: {
  turns: Turn[];
  currentSessionId: string | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  /** Whether the list should follow new content to the bottom. Starts stuck. */
  const stickRef = useRef(true);

  /** Cheap signature of the rendered content: id + text length per turn. When it
   *  changes, content grew/changed and we may need to re-stick to the bottom. */
  const sig = turns.map((t) => `${t.id}:${t.text.length}`).join('|');

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    // Smoothly follow new content to the bottom. CSS `scroll-behavior: smooth`
    // (on the container below) makes this assignment ease instead of jumping.
    el.scrollTop = el.scrollHeight;
  }, [sig, scrollRef]);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distanceFromBottom < STICK_THRESHOLD_PX;
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="absolute inset-0 z-20 overflow-y-auto"
      style={{
        scrollbarWidth: 'none',
        scrollBehavior: 'smooth',
        // Fade the chat text out toward the bottom (where the orb sits) using an
        // alpha mask — a real clip/fade, NOT a blur. The fade starts higher up
        // (~55%) and ramps over a taller band so more of the bottom dissolves.
        maskImage:
          'linear-gradient(to bottom, black 0%, black 55%, rgba(0,0,0,0.35) 78%, transparent 92%)',
        WebkitMaskImage:
          'linear-gradient(to bottom, black 0%, black 55%, rgba(0,0,0,0.35) 78%, transparent 92%)',
      }}
    >
      <div className="mx-auto flex w-full max-w-[min(760px,92vw)] flex-col gap-4 px-6 pb-[40vh] pt-[12vh]">
        {turns.map((turn) =>
          turn.role === 'user' ? (
            <div key={turn.id} className="flex justify-end">
              <div
                data-selectable
                className="max-w-[80%] rounded-3xl rounded-br-lg bg-white/20 px-4 py-2.5 text-[15px] leading-relaxed text-white"
              >
                {turn.text}
              </div>
            </div>
          ) : (
            <div key={turn.id} className="flex justify-start">
              <div className="w-full max-w-[92%] text-[15px] leading-relaxed text-white/90">
                {/* animate only the LIVE streaming turn; settled turns render
                    static so they don't re-fade when the durable transcript
                    replaces the live one on completion. */}
                <HomeAssistantBlocks
                  blocks={turn.blocks}
                  animate={turn.animate && !turn.done}
                />
              </div>
            </div>
          ),
        )}

        <HomeApprovals sessionId={currentSessionId} />
      </div>
    </div>
  );
}

export default MessageList;
