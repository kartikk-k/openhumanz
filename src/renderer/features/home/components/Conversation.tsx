/**
 * Conversation — the scrollable stream of intent-threads on the home screen.
 *
 * Restores the proven layout: each thread owns a full viewport (min-h-screen),
 * top-anchored, with scroll-snap so you see ONE conversation at a time and
 * scroll up for history. A thread groups a whole INTENT (a question + its answer
 * AND any follow-up where the user replies to an ask/draft) — see groupThreads —
 * so answering the assistant doesn't jump to a new screen.
 *
 * User questions render as the shrink-to-fit hero (SettledQuestion). Assistant
 * answers render through TaggedAssistant — only the minimal tagged output
 * (say/ask streams word-by-word; cards) is shown; tool calls / reasoning are
 * hidden (they drive the activity chip and live in the chat tab).
 */
import { settledFont } from '../lib/settledText';
import { groupExchanges, type Turn } from '../lib/turns';
import { SettledQuestion } from './SettledQuestion';
import { TaggedAssistant } from './TaggedAssistant';
import { HomeApprovals } from './HomeApprovalCard';

export function Conversation({
  turns,
  currentSessionId,
  scrollRef,
  liveExchangeRef,
  onScroll,
  recenter,
  onConfirmSend,
  onConfirmEdit,
  typingSlot,
  typingSlotRef,
}: {
  turns: Turn[];
  currentSessionId: string | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  liveExchangeRef: React.RefObject<HTMLElement | null>;
  onScroll: () => void;
  recenter: () => void;
  /** confirm-card "Send" — approve the drafted action. */
  onConfirmSend?: (detail: string) => void;
  /** confirm-card "Edit" — drop the drafted content into the composer. */
  onConfirmEdit?: (detail: string) => void;
  /** the "/"-typing surface, rendered as a trailing thread so it scrolls into
   *  its own fresh space (like a new question) instead of floating on top. */
  typingSlot?: React.ReactNode;
  typingSlotRef?: React.RefObject<HTMLElement | null>;
}) {
  // One Q+A per screen: every user turn opens a new full-viewport exchange, so
  // you always see ONE conversation at a time and scroll-snap between them.
  const exchanges = groupExchanges(turns);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="absolute inset-0 z-20 overflow-y-auto"
      style={{ scrollbarWidth: 'none', scrollSnapType: 'y mandatory' }}
    >
      {exchanges.map((thread, gi, groups) => (
        <section
          key={thread[0].id}
          ref={gi === groups.length - 1 ? liveExchangeRef : undefined}
          // one exchange = one full viewport, its content CENTERED so a Q+A sits
          // in the middle of the screen. Scroll-snap steps cleanly between them.
          className="flex min-h-screen flex-col items-center justify-center gap-6 px-6"
          style={{ scrollSnapAlign: 'center' }}
        >
          {thread.map((turn) => {
            const isUser = turn.role === 'user';
            const hasAnswer = thread.some((x) => x.role === 'assistant');
            const colClass =
              'flex w-full max-w-[min(880px,92vw)] flex-col items-center';

            // User question — shrink-to-fit hero; collapses to a compact header
            // once the thread has an assistant answer.
            if (isUser) {
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

            // Assistant — only the tagged output. Live turns stream word-by-word
            // (animate); past turns render settled so they don't replay on
            // scroll.
            return (
              <div
                key={turn.id}
                className={`${colClass} ${
                  turn.done ? 'transition-opacity duration-500' : ''
                }`}
              >
                <TaggedAssistant
                  blocks={turn.blocks}
                  animate={turn.animate}
                  onApprove={onConfirmSend}
                  onEdit={onConfirmEdit}
                  onGrow={recenter}
                />
              </div>
            );
          })}

          {/* Approval cards — only on the live thread. */}
          {gi === groups.length - 1 && (
            <div className="w-full max-w-[min(760px,92vw)]">
              <HomeApprovals sessionId={currentSessionId} />
            </div>
          )}
        </section>
      ))}

      {/* Typing surface — its OWN full-viewport section at the very bottom, so
          it scrolls into fresh space like a new question (never overlaps the
          previous thread). Only present while typing. */}
      {typingSlot && (
        <section
          ref={typingSlotRef}
          className="flex min-h-screen flex-col items-center justify-center px-6"
          style={{ scrollSnapAlign: 'center' }}
        >
          <div className="flex w-full max-w-[min(880px,92vw)] flex-col items-center">
            {typingSlot}
          </div>
        </section>
      )}
    </div>
  );
}

export default Conversation;
