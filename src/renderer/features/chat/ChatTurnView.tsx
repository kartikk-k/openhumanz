/**
 * Renders one folded chat turn — a user or assistant message and its blocks.
 *
 * Blocks come from the shared transcript parser: plain text, collapsible
 * thinking, and tool calls (each with its input, its result, and — for the
 * Task tool — the subagent's own nested blocks). The point is fidelity: this
 * shows what the assistant actually did, not a sanitized summary.
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
import { cn } from '../../lib/utils';
import { mono, textMuted, textSubtle } from '../../components/ui/styles';
import { Markdown } from '../../components/ui/Markdown';
import type {
  ChatBlock,
  ChatToolCall,
  ChatTurn,
} from '../../../shared/claudeTranscript.fold';

/** Truncate a long result/input for inline display. */
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

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-zinc-200/70 dark:border-zinc-800/70">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-1.5 px-2 py-1.5 text-[12px]',
          textMuted,
        )}
      >
        <ChevronRight
          size={12}
          aria-hidden
          className={cn('transition-transform', open && 'rotate-90')}
        />
        <Brain size={12} aria-hidden />
        Thinking
      </button>
      {open ? (
        <div
          data-selectable
          className={cn(
            'whitespace-pre-wrap border-t border-zinc-200/70 px-3 py-2 text-[12.5px] italic leading-relaxed dark:border-zinc-800/70',
            textSubtle,
          )}
        >
          {text}
        </div>
      ) : null}
    </div>
  );
}

function ToolResultIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircle2 size={12} className="text-emerald-500" aria-hidden />
  ) : (
    <XCircle size={12} className="text-rose-500" aria-hidden />
  );
}

function ToolCallView({ call }: { call: ChatToolCall }) {
  const [open, setOpen] = useState(false);
  const inputStr = stringifyInput(call.input);
  const hasDetail =
    Boolean(inputStr) || Boolean(call.result) || Boolean(call.subagent);

  return (
    <div className="rounded-md border border-zinc-200/70 dark:border-zinc-800/70">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-1.5 px-2 py-1.5 text-[12px]',
          textSubtle,
        )}
      >
        {hasDetail ? (
          <ChevronRight
            size={12}
            aria-hidden
            className={cn('transition-transform', open && 'rotate-90')}
          />
        ) : (
          <span className="w-3" />
        )}
        <Wrench size={12} aria-hidden className="shrink-0" />
        <span className={cn(mono, 'text-zinc-700 dark:text-zinc-300')}>
          {call.name}
        </span>
        {call.result ? (
          <span className="ml-auto">
            <ToolResultIcon ok={call.result.ok} />
          </span>
        ) : null}
      </button>

      {open && hasDetail ? (
        <div className="border-t border-zinc-200/70 dark:border-zinc-800/70">
          {inputStr ? (
            <pre
              data-selectable
              className="overflow-x-auto px-3 py-2 text-[11.5px] leading-relaxed text-zinc-600 dark:text-zinc-400"
            >
              {clip(inputStr, 1200)}
            </pre>
          ) : null}

          {call.result ? (
            <pre
              data-selectable
              className={cn(
                'overflow-x-auto border-t border-zinc-200/70 px-3 py-2 text-[11.5px] leading-relaxed dark:border-zinc-800/70',
                call.result.ok
                  ? 'text-zinc-600 dark:text-zinc-400'
                  : 'text-rose-600 dark:text-rose-400',
              )}
            >
              {clip(call.result.text)}
            </pre>
          ) : null}

          {call.subagent ? (
            <div className="border-t border-zinc-200/70 px-2 py-2 dark:border-zinc-800/70">
              <div
                className={cn(
                  'mb-1.5 flex items-center gap-1.5 text-[11.5px] font-medium',
                  textMuted,
                )}
              >
                <Bot size={12} aria-hidden />
                subagent{call.subagent.name ? `: ${call.subagent.name}` : ''}
              </div>
              <div className="flex flex-col gap-1.5 border-l-2 border-zinc-200 pl-2 dark:border-zinc-800">
                {call.subagent.blocks.map((block, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <BlockView key={i} block={block} />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function BlockView({ block }: { block: ChatBlock }) {
  if (block.kind === 'text') {
    return (
      <div
        data-selectable
        className="text-[13.5px] leading-relaxed text-zinc-800 dark:text-zinc-100"
      >
        <Markdown>{block.text}</Markdown>
      </div>
    );
  }
  if (block.kind === 'thinking') {
    return <ThinkingBlock text={block.text} />;
  }
  return <ToolCallView call={block.call} />;
}

/**
 * Render an assistant message's blocks. Shared by saved turns and the live
 * streaming turn so both render identically.
 */
export function AssistantBlocks({ blocks }: { blocks: ChatBlock[] }) {
  return (
    <div className="flex justify-start">
      <div className="flex max-w-[88%] flex-col gap-2">
        {blocks.map((block, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <BlockView key={i} block={block} />
        ))}
      </div>
    </div>
  );
}

export function ChatTurnView({ turn }: { turn: ChatTurn }) {
  const { message } = turn;

  if (message.role === 'user') {
    const text = message.blocks
      .filter(
        (b): b is Extract<ChatBlock, { kind: 'text' }> => b.kind === 'text',
      )
      .map((b) => b.text)
      .join('\n')
      .trim();
    return (
      <div className="flex justify-end">
        <div
          data-selectable
          className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-indigo-600 px-3.5 py-2 text-[13.5px] leading-relaxed text-white"
        >
          {text || (message.hasAttachments ? '(attachment)' : '')}
          {message.hasAttachments && text ? (
            <span className="ml-1 opacity-70">📎</span>
          ) : null}
        </div>
      </div>
    );
  }

  return <AssistantBlocks blocks={message.blocks} />;
}

export default ChatTurnView;
