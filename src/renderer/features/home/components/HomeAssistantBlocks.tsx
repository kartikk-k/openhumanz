/**
 * HomeAssistantBlocks — renders an assistant turn's blocks for the home screen.
 *
 * A real Claude Code turn is multi-block: markdown prose, collapsible thinking,
 * and tool calls (each with input/result and, for the Task tool, a nested
 * sub-agent). The chat tab renders these via ChatTurnView; this is the home
 * equivalent — same structure, but styled for the dark ambient look and with a
 * response-length font scale so a short reply reads large and a long one settles
 * to a comfortable reading size. Tool calls / thinking / sub-agents are
 * collapsed by default.
 *
 * Deliberately separate from the chat tab's ChatTurnView (which stays untouched).
 * Markdown hierarchy (headings, bold, quotes, lists, code) is preserved via the
 * shared, streaming-safe <Markdown> renderer, which already handles dark mode.
 */
import { useState } from 'react';
import {
  Brain,
  CheckCircle2,
  ChevronRight,
  Wrench,
  XCircle,
  Bot,
} from 'lucide-react';
import { HomeMarkdown } from './HomeMarkdown';
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

/**
 * Font scale for the whole answer, by total text length. Short answers read
 * large and confident; long ones settle to a comfortable reading size. Markdown
 * hierarchy (h1/h2/bold) is applied RELATIVE to this base inside <Markdown>, so
 * headings stay proportionally larger than body at every scale.
 */
function baseFontPx(textLength: number): number {
  if (textLength <= 80) return 30; // a sentence or two — hero-ish
  if (textLength <= 220) return 24;
  if (textLength <= 500) return 20;
  if (textLength <= 1000) return 18;
  return 16; // long, reading-comfortable
}

function HomeThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.04]">
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
    <div className="rounded-xl border border-white/10 bg-white/[0.04]">
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
                {call.subagent.blocks.map((block, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <HomeBlock key={i} block={block} />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function HomeBlock({ block }: { block: ChatBlock }) {
  if (block.kind === 'text') {
    return (
      <div data-selectable className="leading-relaxed text-white/90">
        <HomeMarkdown>{block.text}</HomeMarkdown>
      </div>
    );
  }
  if (block.kind === 'thinking') {
    return <HomeThinkingBlock text={block.text} />;
  }
  return <HomeToolCall call={block.call} />;
}

/**
 * Render an assistant message's blocks in the home style. The whole block sizes
 * its base font by total text length; markdown headings/bold scale relative to
 * that. Left-aligned prose in a centered reading column.
 */
export function HomeAssistantBlocks({ blocks }: { blocks: ChatBlock[] }) {
  const textLength = blocks
    .filter((b): b is Extract<ChatBlock, { kind: 'text' }> => b.kind === 'text')
    .reduce((n, b) => n + b.text.length, 0);
  const fontSize = baseFontPx(textLength);

  return (
    <div
      className="flex w-full flex-col gap-3 text-left"
      style={{ fontSize, lineHeight: 1.4 }}
    >
      {blocks.map((block, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <HomeBlock key={i} block={block} />
      ))}
    </div>
  );
}

export default HomeAssistantBlocks;
