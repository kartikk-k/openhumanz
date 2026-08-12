/**
 * TaggedAssistant — renders an assistant turn on the HOME surface.
 *
 * The home system prompt makes Claude wrap only user-facing output in namespaced
 * tags ([openhumanz-say] / [openhumanz-ask] / [openhumanz-card/…]); everything
 * else it writes is background narration. This flattens the turn's TEXT blocks,
 * parses the tags, and renders ONLY those nodes — minimal speech + cards. All
 * untagged prose and every tool call is dropped from this view (they still live
 * in the raw transcript, visible in the chat tab, and drive the activity chip).
 *
 * So a turn that in the chat tab is ten tool calls + paragraphs of reasoning is
 * here just: "Sent it to #general." or a confirm card. That is the whole point.
 *
 * STREAMING: say / ask text now streams in word-by-word through AutoMergeText —
 * words fade/blur in and the block merges down size steps as it grows. Because
 * the turn is re-parsed whole on every streamed token, each node keeps a STABLE
 * positional key so React preserves the same AutoMergeText instance as its text
 * grows (keying on the text would remount every token and restart the animation;
 * AutoMergeText is safe to feed growing text — it only resets when the word count
 * DECREASES). A card still appears the moment its tag completes. Past turns pass
 * `animate={false}` so settled text renders as plain <p> and never replays.
 */
import { parseTags } from '../lib/tags';
import type { ChatBlock } from '../../../../shared/claudeTranscript.fold';
import { AutoMergeText } from '../text/AutoMergeText';
import { WeatherCard, CalendarWeekCard, ConfirmCard } from './cards/HomeCards';

/** Join all text blocks (tool/thinking blocks carry no tagged output). */
function textOf(blocks: ChatBlock[]): string {
  return blocks
    .filter((b): b is Extract<ChatBlock, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.text)
    .join('\n');
}

export function TaggedAssistant({
  blocks,
  animate = true,
  onApprove,
  onEdit,
  onGrow,
}: {
  blocks: ChatBlock[];
  /** Stream say/ask text word-by-word (default). Off = settled, no replay. */
  animate?: boolean;
  /** confirm-card actions (send / edit the drafted content). */
  onApprove?: (detail: string) => void;
  onEdit?: (detail: string) => void;
  /** Fires as streaming text reveals/merges, so a parent can keep it centered. */
  onGrow?: () => void;
}) {
  const nodes = parseTags(textOf(blocks));
  if (nodes.length === 0) return null;

  return (
    <div className="flex w-full flex-col items-center gap-4 text-center">
      {nodes.map((node, i) => {
        // Stable positional key: the turn is re-parsed whole on every streamed
        // token, so keying on index+kind (never on text) keeps the same
        // AutoMergeText instance alive as its text grows.
        const key = `${node.kind}-${i}`;

        if (node.kind === 'say' || node.kind === 'ask') {
          const color = node.kind === 'say' ? 'text-white/90' : 'text-white/80';

          if (animate) {
            return (
              <AutoMergeText
                key={key}
                text={node.text}
                className={color}
                onGrow={onGrow}
              />
            );
          }

          return (
            <p
              key={key}
              data-selectable
              className={`text-center text-[26px] font-medium leading-snug tracking-tight ${color}`}
              style={{ maxWidth: '46ch', textWrap: 'balance' }}
            >
              {node.text}
            </p>
          );
        }

        // card
        if (node.cardType === 'weather') {
          return <WeatherCard key={key} attrs={node.attrs} />;
        }
        if (node.cardType === 'calendar-week') {
          return <CalendarWeekCard key={key} attrs={node.attrs} />;
        }
        if (node.cardType === 'confirm') {
          const detail = node.attrs.detail ?? '';
          return (
            <ConfirmCard
              key={key}
              attrs={node.attrs}
              onApprove={onApprove ? () => onApprove(detail) : undefined}
              onEdit={onEdit ? () => onEdit(detail) : undefined}
            />
          );
        }
        // unknown card type — drop silently (protocol may add more later).
        return null;
      })}
    </div>
  );
}

export default TaggedAssistant;
