/**
 * HomeAssistantBlocks — renders an assistant turn for the home screen.
 *
 * A real Claude Code turn is multi-block: markdown prose, collapsible thinking,
 * and tool calls (each with input/result and, for the Task tool, a nested
 * sub-agent). The chat tab renders these via ChatTurnView; this is the home
 * equivalent, dark-styled, with tool calls / thinking / sub-agents collapsed.
 *
 * STREAMING: the WHOLE turn is rendered by a single flowtoken `AnimatedMarkdown`
 * so everything — prose, headings, lists, AND the tool-call/thinking chips —
 * streams in as one smooth flow. We serialize the blocks into one markdown
 * string where tool/thinking blocks become custom `<homeblock/>` tags, and map
 * those tags to real components via flowtoken's `customComponents`. Because it
 * diffs `content` (sep="diff"), only NEW tokens animate as the turn grows — no
 * per-block pop-in, no remount.
 */
import { useMemo, useRef, useState } from 'react';
import {
  Brain,
  CheckCircle2,
  ChevronRight,
  Wrench,
  XCircle,
  Bot,
} from 'lucide-react';
import { AnimatedMarkdown } from 'flowtoken';
import 'flowtoken/dist/styles.css';
import type {
  ChatBlock,
  ChatToolCall,
} from '../../../../shared/claudeTranscript.fold';

/** Truncate long input/result for inline display. */
function clip(text: string, max = 2000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

function stringifyInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** Font scale for the whole answer, by total text length. */
function baseFontPx(textLength: number): number {
  if (textLength <= 80) return 30;
  if (textLength <= 220) return 24;
  if (textLength <= 500) return 20;
  if (textLength <= 1000) return 18;
  return 16;
}

function HomeThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2 rounded-xl border border-white/10 bg-white/[0.04]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-xs text-white/45 transition hover:text-white/70"
      >
        <ChevronRight
          size={12}
          aria-hidden
          className={`transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <Brain size={12} aria-hidden />
        Thinking
      </button>
      {open ? (
        <div
          data-selectable
          className="whitespace-pre-wrap border-t border-white/10 px-3 py-2 text-xs italic leading-relaxed text-white/50"
        >
          {text}
        </div>
      ) : null}
    </div>
  );
}

function ToolResultIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircle2 size={12} className="text-emerald-400" aria-hidden />
  ) : (
    <XCircle size={12} className="text-rose-400" aria-hidden />
  );
}

function HomeToolCall({ call }: { call: ChatToolCall }) {
  const [open, setOpen] = useState(false);
  const inputStr = stringifyInput(call.input);
  const hasDetail =
    Boolean(inputStr) || Boolean(call.result) || Boolean(call.subagent);

  return (
    <div className="my-2 rounded-xl border border-white/10 bg-white/[0.04]">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-xs text-white/55 transition hover:text-white/80"
      >
        {hasDetail ? (
          <ChevronRight
            size={12}
            aria-hidden
            className={`transition-transform ${open ? 'rotate-90' : ''}`}
          />
        ) : (
          <span className="w-3" />
        )}
        <Wrench size={12} aria-hidden className="shrink-0" />
        <span className="font-mono text-white/70">{call.name}</span>
        {call.result ? (
          <span className="ml-auto">
            <ToolResultIcon ok={call.result.ok} />
          </span>
        ) : null}
      </button>

      {open && hasDetail ? (
        <div className="border-t border-white/10">
          {inputStr ? (
            <pre
              data-selectable
              className="overflow-x-auto px-3 py-2 text-[11.5px] leading-relaxed text-white/50"
            >
              {clip(inputStr, 1200)}
            </pre>
          ) : null}

          {call.result ? (
            <pre
              data-selectable
              className={`overflow-x-auto border-t border-white/10 px-3 py-2 text-[11.5px] leading-relaxed ${
                call.result.ok ? 'text-white/50' : 'text-rose-300/80'
              }`}
            >
              {clip(call.result.text)}
            </pre>
          ) : null}

          {call.subagent ? (
            <div className="border-t border-white/10 px-2 py-2">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-medium text-white/45">
                <Bot size={12} aria-hidden />
                subagent{call.subagent.name ? `: ${call.subagent.name}` : ''}
              </div>
              <div className="flex flex-col gap-1.5 border-l-2 border-white/10 pl-2">
                {call.subagent.blocks.map((b, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <SubBlock key={i} block={b} />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A block inside a sub-agent (tool / thinking / plain text). */
function SubBlock({ block }: { block: ChatBlock }) {
  if (block.kind === 'tool') return <HomeToolCall call={block.call} />;
  if (block.kind === 'thinking') return <HomeThinkingBlock text={block.text} />;
  return <div className="whitespace-pre-wrap text-white/70">{block.text}</div>;
}

/**
 * Serialize the turn's blocks into one markdown string for AnimatedMarkdown.
 * Text blocks pass through verbatim; tool/thinking blocks become a custom
 * self-closing tag referencing the block by index, resolved by customComponents.
 * Returns the string plus the ordered non-text blocks it referenced.
 */
function serialize(blocks: ChatBlock[]): {
  content: string;
  chips: ChatBlock[];
} {
  const chips: ChatBlock[] = [];
  const parts: string[] = [];
  blocks.forEach((block) => {
    if (block.kind === 'text') {
      parts.push(block.text);
    } else {
      const idx = chips.length;
      chips.push(block);
      // custom tag on its own lines so markdown treats it as a block.
      parts.push(`\n\n<homeblock idx="${idx}"></homeblock>\n\n`);
    }
  });
  return { content: parts.join(''), chips };
}

export function HomeAssistantBlocks({
  blocks,
  animate = true,
}: {
  blocks: ChatBlock[];
  /** false for settled turns — render static so they don't re-fade. */
  animate?: boolean;
}) {
  const textLength = blocks
    .filter((b): b is Extract<ChatBlock, { kind: 'text' }> => b.kind === 'text')
    .reduce((n, b) => n + b.text.length, 0);
  const fontSize = baseFontPx(textLength);

  const { content, chips } = serialize(blocks);

  // Keep the current chips in a ref so the customComponents object (and the tag
  // component's type) stays STABLE across renders — otherwise flowtoken would
  // remount the chips on every streamed token.
  const chipsRef = useRef<ChatBlock[]>(chips);
  chipsRef.current = chips;

  // Resolve a <homeblock idx="N"/> tag to its tool/thinking chip. Memoized with
  // a chips ref so the component type is stable (no remount on stream tokens).
  const components = useMemo(
    () => ({
      // eslint-disable-next-line react/no-unstable-nested-components, react/no-unused-prop-types
      homeblock: ({ idx }: { idx?: string }) => {
        const block = chipsRef.current[Number(idx)];
        if (block?.kind === 'thinking')
          return <HomeThinkingBlock text={block.text} />;
        if (block?.kind === 'tool') return <HomeToolCall call={block.call} />;
        return null;
      },
    }),
    [],
  );

  return (
    <div
      className="ft-markdown flex w-full flex-col text-left text-white/90"
      style={{ fontSize, lineHeight: 1.5 }}
    >
      <AnimatedMarkdown
        content={content}
        sep="word"
        // null animation = render immediately, no fade (settled turns).
        animation={animate ? 'blurIn' : null}
        animationDuration="0.6s"
        animationTimingFunction="ease-out"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        customComponents={components as any}
      />
    </div>
  );
}

export default HomeAssistantBlocks;
