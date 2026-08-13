/**
 * Selected bot: header, transcript, overflow (rename / archive).
 */
import { useEffect, useRef, useState } from 'react';
import { MessageSquare, MoreHorizontal } from 'lucide-react';
import { MAIN_BOT_ID } from '../../../shared/bots';
import type { BotMessage } from '../../../shared/bots';
import type { ChatBlock } from '../../../shared/claudeTranscript.fold';
import { cn } from '../../lib/utils';
import { Button, EmptyState, Spinner } from '../../components/ui';
import { textMuted, textSubtle } from '../../components/ui/styles';
import {
  useBotsStore,
  useSelectedBot,
  useSelectedMessages,
  usePendingApprovalsForRun,
  useApprovalsStore,
} from '../../store';
import type { Approval, ApprovalScope } from '../../../shared/approvals';
import { ApprovalCard } from '../approvals/ApprovalCard';
import { AssistantBlocks } from '../chat/ChatTurnView';
import { BotOrb } from './colors';

/**
 * Inline approve/deny for a bot thread. A bot run is interactive, so a tool that
 * needs approval holds the call open and posts an approval card right here in
 * the thread — the same as the home chat — instead of dead-ending the user into
 * Settings. Approvals are matched to the bot's currently-active run.
 */
function BotApprovals({ runId }: { runId: string | null }) {
  const pending = usePendingApprovalsForRun(runId);
  const resolve = useApprovalsStore((state) => state.resolve);
  const resolving = useApprovalsStore((state) => state.resolving);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (pending.length === 0) return null;
  const onApprove = (approval: Approval, scope: ApprovalScope): void => {
    void resolve({ approvalId: approval.id, decision: 'approve', scope });
  };
  const onDeny = (approval: Approval): void => {
    void resolve({ approvalId: approval.id, decision: 'deny' });
  };
  return (
    <div className="flex w-full flex-col gap-3">
      {pending.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          now={Date.now()}
          busy={resolving === approval.id}
          expanded={expandedId === approval.id}
          onExpandedChange={(open) => setExpandedId(open ? approval.id : null)}
          onApprove={onApprove}
          onDeny={onDeny}
        />
      ))}
    </div>
  );
}

function firstText(blocks: ChatBlock[]): string {
  return blocks
    .filter(
      (block): block is Extract<ChatBlock, { kind: 'text' }> =>
        block.kind === 'text',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function BotMessageView({
  message,
  botName,
}: {
  message: BotMessage;
  botName: string;
}) {
  if (message.role === 'user') {
    const text = firstText(message.blocks);
    return (
      <div className="flex justify-end">
        <div
          data-selectable
          className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-indigo-600 px-3.5 py-2 text-[13.5px] leading-relaxed text-white"
        >
          {text}
        </div>
      </div>
    );
  }

  if (message.role === 'system') {
    const text = firstText(message.blocks);
    if (!text) return null;
    return <p className={cn('text-center text-[12px]', textSubtle)}>{text}</p>;
  }

  // Empty + a live runId is still streaming. Empty with no run never started.
  const working = message.blocks.length === 0 && Boolean(message.runId);
  const failedToStart = message.blocks.length === 0 && !message.runId;
  const author =
    message.author && message.author !== botName ? message.author : null;

  return (
    <div className="flex flex-col items-start gap-1">
      {author ? (
        <span className={cn('px-0.5 text-[11px]', textSubtle)}>
          {message.source === 'schedule' ? 'Scheduled · ' : ''}
          {author}
        </span>
      ) : null}
      {working && (
        <div className={cn('flex items-center gap-2 text-[13px]', textMuted)}>
          <Spinner size="xs" label={null} />
          Working…
        </div>
      )}
      {failedToStart && (
        <p className={cn('text-[13px]', textMuted)}>The run did not start.</p>
      )}
      {!working && !failedToStart && (
        <AssistantBlocks blocks={message.blocks} />
      )}
    </div>
  );
}

function OverflowMenu({
  canArchive,
  onRename,
  onArchive,
}: {
  canArchive: boolean;
  onRename: () => void;
  onArchive: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <Button
        size="icon"
        variant="ghost"
        icon={MoreHorizontal}
        aria-label="Bot actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="h-11 w-11 shrink-0"
      />
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 min-w-[10rem] rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        >
          <button
            type="button"
            role="menuitem"
            className="flex h-11 w-full items-center px-3 text-left text-[13px] text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
            onClick={() => {
              setOpen(false);
              onRename();
            }}
          >
            Rename
          </button>
          {canArchive ? (
            <button
              type="button"
              role="menuitem"
              className="flex h-11 w-full items-center px-3 text-left text-[13px] text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
              onClick={() => {
                setOpen(false);
                onArchive();
              }}
            >
              Archive
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function BotThreadHeader({
  onRename,
  onArchive,
}: {
  onRename: () => void;
  onArchive: () => void;
}) {
  const bot = useSelectedBot();
  if (!bot) return null;

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-200/60 px-3 dark:border-zinc-800/60">
      <BotOrb color={bot.avatarColor} size={24} />
      <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">
        {bot.name}
      </h2>
      <OverflowMenu
        canArchive={bot.id !== MAIN_BOT_ID}
        onRename={onRename}
        onArchive={onArchive}
      />
    </div>
  );
}

export function BotThread() {
  const bot = useSelectedBot();
  const messages = useSelectedMessages();
  const selectedBotId = useBotsStore((state) => state.selectedBotId);
  const pending = useBotsStore((state) =>
    selectedBotId ? (state.pendingByBot[selectedBotId] ?? null) : null,
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  const last = messages[messages.length - 1];
  const lastIsPendingUser =
    last?.role === 'user' && firstText(last.blocks) === pending;
  const showPending = pending != null && !lastIsPendingUser;

  // The run currently streaming into this thread — the anchor an approval card
  // is matched to. The newest bot message with a runId is the live one.
  const activeRunId =
    [...messages].reverse().find((m) => m.role === 'bot' && m.runId)?.runId ??
    null;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, showPending, pending]);

  if (!bot) return null;

  const empty = messages.length === 0 && !showPending;

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
        {empty ? (
          <EmptyState
            icon={MessageSquare}
            title="Message this bot to start a thread."
            description="Turns run in the background. Switching bots will not cancel anything."
            size="sm"
            className="pt-16"
          />
        ) : (
          messages.map((message) => (
            <BotMessageView
              key={message.id}
              message={message}
              botName={bot.name}
            />
          ))
        )}

        {showPending ? (
          <div className="flex justify-end">
            <div
              data-selectable
              className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-indigo-600 px-3.5 py-2 text-[13.5px] leading-relaxed text-white"
            >
              {pending}
            </div>
          </div>
        ) : null}

        <BotApprovals runId={activeRunId} />
      </div>
    </div>
  );
}

export default BotThread;
