/**
 * Chat.
 *
 * A direct line to the assistant. You type, it answers, and — unlike a plain
 * chatbot — it can actually *do* things: every message runs through the same
 * engine as Runs, so the assistant has the full tool surface (mail, calendar,
 * memory, files, scheduling…), and anything with a side effect stops at the
 * same approval gate. Workflows and scheduled jobs it creates show up in their
 * own screens; this is just the front door.
 *
 * Each message is one run that continues the previous one's session, so context
 * carries across the conversation. The assistant's `message` events become its
 * reply; tool use and approvals are surfaced quietly beneath it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUp,
  MessageSquare,
  ShieldAlert,
  Wrench,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { ROUTES } from '../../routes';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { textMuted, textSubtle } from '../../components/ui/styles';
import { useRunEvents, useRunsStore } from '../../store';
import {
  foldTurn,
  isTurnDone,
  type AssistantTurn,
  type ChatToolActivity,
} from './chatModel';

/** The status glyph for one tool activity row. */
function ToolStateIcon({ state }: { state: ChatToolActivity['state'] }) {
  if (state === 'running') return <Spinner size="xs" label={null} />;
  if (state === 'error') {
    return <XCircle size={12} className="text-rose-500" aria-hidden />;
  }
  return <CheckCircle2 size={12} className="text-emerald-500" aria-hidden />;
}

interface Turn {
  id: string;
  userText: string;
  /** The run spawned for this turn, once it has been created. */
  runId: string | null;
  /** Set if the run failed to even start. */
  startError: string | null;
}

/** One assistant reply, folded live from its run's event stream. */
function AssistantBubble({ runId }: { runId: string | null }) {
  const events = useRunEvents(runId);
  const turn: AssistantTurn = useMemo(() => foldTurn(events), [events]);
  const navigate = useNavigate();

  const done = isTurnDone(turn.status);
  const thinking = !done && turn.text.length === 0 && !turn.awaitingApproval;

  return (
    <div className="flex flex-col gap-1.5">
      {thinking ? (
        <div className={cn('flex items-center gap-2 text-[13px]', textMuted)}>
          <Spinner size="xs" label={null} />
          Thinking…
        </div>
      ) : null}

      {turn.text ? (
        <div
          data-selectable
          className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-zinc-800 dark:text-zinc-100"
        >
          {turn.text}
        </div>
      ) : null}

      {turn.tools.length > 0 ? (
        <div className="flex flex-col gap-1 pt-0.5">
          {turn.tools.map((tool) => (
            <div
              key={tool.id}
              className={cn(
                'flex items-center gap-1.5 text-[12px]',
                textSubtle,
              )}
            >
              <ToolStateIcon state={tool.state} />
              <Wrench size={11} aria-hidden className="shrink-0" />
              <span className="font-mono">{tool.name}</span>
            </div>
          ))}
        </div>
      ) : null}

      {turn.awaitingApproval ? (
        <button
          type="button"
          onClick={() => navigate(ROUTES.approvals)}
          className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[12px] font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
        >
          <ShieldAlert size={13} aria-hidden />
          Waiting on your approval — review it
        </button>
      ) : null}

      {turn.status === 'failed' ? (
        <div className="mt-1 flex items-start gap-1.5 text-[12px] text-rose-600 dark:text-rose-400">
          <XCircle size={13} aria-hidden className="mt-px shrink-0" />
          <span>
            {turn.error ?? 'The assistant could not finish this turn.'}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function ChatScreen() {
  const startRun = useRunsStore((state) => state.startRun);
  const watchRun = useRunsStore((state) => state.watchRun);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The session of the most recent run, so the next message continues it.
  const lastRunId = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      if (turns[i].runId) return turns[i].runId;
    }
    return null;
  }, [turns]);

  // Keep the newest message in view as content streams in.
  const events = useRunEvents(lastRunId);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, events]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;

    const turnId = `turn-${Date.now()}`;
    setTurns((prev) => [
      ...prev,
      { id: turnId, userText: text, runId: null, startError: null },
    ]);
    setDraft('');
    setSending(true);

    try {
      const run = await startRun({
        prompt: text,
        trigger: 'manual',
      });
      if (!run) {
        setTurns((prev) =>
          prev.map((turn) =>
            turn.id === turnId
              ? { ...turn, startError: 'The run could not be started.' }
              : turn,
          ),
        );
        return;
      }
      setTurns((prev) =>
        prev.map((turn) =>
          turn.id === turnId ? { ...turn, runId: run.id } : turn,
        ),
      );
      void watchRun(run.id);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setTurns((prev) =>
        prev.map((turn) =>
          turn.id === turnId ? { ...turn, startError: message } : turn,
        ),
      );
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  }, [draft, sending, startRun, watchRun]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter is a newline. Standard chat ergonomics.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
          {turns.length === 0 ? (
            <div className="flex flex-col items-center gap-3 pt-24 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-600/10 text-indigo-500">
                <MessageSquare size={22} aria-hidden />
              </div>
              <div>
                <h1 className="text-[15px] font-semibold text-zinc-800 dark:text-zinc-100">
                  What can I do for you?
                </h1>
                <p className={cn('mt-1 max-w-sm text-[13px]', textMuted)}>
                  Ask me to read your mail, check your calendar, remember
                  something, or run a task. Anything with a side effect will ask
                  for your approval first.
                </p>
              </div>
            </div>
          ) : null}

          {turns.map((turn) => (
            <div key={turn.id} className="flex flex-col gap-3">
              {/* User bubble, right-aligned. */}
              <div className="flex justify-end">
                <div
                  data-selectable
                  className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-indigo-600 px-3.5 py-2 text-[13.5px] leading-relaxed text-white"
                >
                  {turn.userText}
                </div>
              </div>

              {/* Assistant reply, left-aligned. */}
              <div className="flex justify-start">
                <div className="max-w-[85%]">
                  {turn.startError ? (
                    <div className="flex items-start gap-1.5 text-[12px] text-rose-600 dark:text-rose-400">
                      <XCircle
                        size={13}
                        aria-hidden
                        className="mt-px shrink-0"
                      />
                      <span>{turn.startError}</span>
                    </div>
                  ) : (
                    <AssistantBubble runId={turn.runId} />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Composer. */}
      <div className="shrink-0 border-t border-zinc-200/60 px-4 py-3 dark:border-zinc-800/60">
        <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
          <div className="flex min-h-[44px] flex-1 items-end rounded-2xl border border-zinc-300 bg-white/70 px-3 py-2 focus-within:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-900/50">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Message the assistant…  (Enter to send, Shift+Enter for a new line)"
              className="max-h-40 flex-1 resize-none bg-transparent text-[13.5px] leading-relaxed text-zinc-800 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
            />
          </div>
          <Button
            size="icon"
            variant="primary"
            aria-label="Send"
            disabled={draft.trim().length === 0 || sending}
            loading={sending}
            icon={ArrowUp}
            onClick={() => {
              void send();
            }}
            className="mb-px shrink-0 rounded-full"
          />
        </div>
      </div>
    </div>
  );
}

export default ChatScreen;
