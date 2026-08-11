/**
 * Conversation — the scrollable stream of chat exchanges on the home screen.
 *
 * Each exchange (a user question + its assistant reply) fills at least a full
 * viewport height and is top-anchored, so streaming the response below the
 * question never shoves the question up, and scrolling steps cleanly between
 * conversations. Renders the settled/animated turn variants and the inline
 * approval cards for the live exchange.
 */
import { AutoMergeText } from '../text/AutoMergeText';
import { settledFont } from '../lib/settledText';
import { groupExchanges, type Turn } from '../lib/turns';
import { SettledQuestion } from './SettledQuestion';
import { SettledAnswer } from './SettledText';
import { HomeApprovals } from './HomeApprovalCard';

export function Conversation({
  turns,
  currentSessionId,
  scrollRef,
  liveExchangeRef,
  onScroll,
  recenter,
}: {
  turns: Turn[];
  currentSessionId: string | null;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  liveExchangeRef: React.RefObject<HTMLElement | null>;
  onScroll: () => void;
  recenter: () => void;
}) {
  return (
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
          // top-anchored (not centered): the question stays put once asked and
          // the response streams BELOW it — so adding the response never shoves
          // the question up. Each exchange owns a full viewport so scrolling
          // steps cleanly between conversations.
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

            // The user question settles into a compact header once answered. We
            // render the SAME element before/after the answer and tween it, so
            // big→small is smooth (see SettledQuestion). While still streaming,
            // AutoMergeText owns it and hands off seamlessly.
            if (isUser && turn.done) {
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

            // Past turns render settled, NOT re-streamed — AutoMergeText always
            // plays from the start, so a finished turn would replay on scroll.
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

            // The live streaming turn uses the full word/merge animation.
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

          {/* Approval cards for the live exchange — the agent pauses here until
              you Allow/Deny (e.g. a side-effecting Slack/Composio call). Only on
              the newest exchange. */}
          {gi === groups.length - 1 && (
            <div className="w-full max-w-[min(760px,92vw)]">
              <HomeApprovals sessionId={currentSessionId} />
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

export default Conversation;
