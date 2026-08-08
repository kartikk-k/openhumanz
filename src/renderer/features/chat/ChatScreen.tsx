/**
 * Chat.
 *
 * One continuous Claude Code session — every message resumes the same session,
 * exactly like typing into `claude` in a terminal, so the assistant remembers
 * the whole conversation. Sessions live in the app's `claude-chats` folder; the
 * CLI writes its own rich transcript and we render it: text, collapsible
 * thinking, tool calls with their inputs and results, and subagent activity.
 *
 * "New chat" starts a fresh session. The session list on the left is the
 * history — only this app's chats, never the user's other `claude` projects.
 *
 * The transcript on disk is the source of truth; the store re-reads it whenever
 * main pushes an update, so streamed output appears live.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Plus, Sparkles } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { textMuted, textSubtle } from '../../components/ui/styles';
import { useChatStore } from '../../store';
import type { ChatTurn } from '../../../shared/claudeTranscript.fold';
import { AssistantBlocks, ChatTurnView } from './ChatTurnView';

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The session history rail. */
function SessionList() {
  const sessions = useChatStore((s) => s.sessions);
  const currentId = useChatStore((s) => s.currentSessionId);
  const select = useChatStore((s) => s.selectSession);
  const newChat = useChatStore((s) => s.newChat);

  return (
    <div className="flex w-56 shrink-0 flex-col border-r border-zinc-200/60 [-webkit-app-region:no-drag] dark:border-zinc-800/60">
      <div className="p-2">
        <Button
          size="sm"
          variant="secondary"
          icon={Plus}
          className="w-full justify-center [-webkit-app-region:no-drag]"
          onClick={() => {
            void newChat();
          }}
        >
          New chat
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 ? (
          <p className={cn('px-1 py-2 text-[12px]', textSubtle)}>
            No chats yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sessions.map((session) => (
              <li key={session.sessionId}>
                <button
                  type="button"
                  onClick={() => {
                    void select(session.sessionId);
                  }}
                  className={cn(
                    'w-full rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors',
                    session.sessionId === currentId
                      ? 'bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-zinc-700'
                      : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/60',
                  )}
                >
                  <div className="truncate font-medium">
                    {session.title ?? 'Untitled chat'}
                  </div>
                  <div className={cn('text-[11px]', textSubtle)}>
                    {relativeTime(session.updatedMs)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmptyConversation() {
  return (
    <div className="flex flex-col items-center gap-3 pt-24 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-600/10 text-indigo-500">
        <Sparkles size={22} aria-hidden />
      </div>
      <div>
        <h1 className="text-[15px] font-semibold text-zinc-800 dark:text-zinc-100">
          What can I do for you?
        </h1>
        <p className={cn('mt-1 max-w-sm text-[13px]', textMuted)}>
          This is one continuous session — I remember everything in this chat.
          Ask me to read your mail, check your calendar, remember something, or
          run a task. Anything with a side effect asks for your approval first.
        </p>
      </div>
    </div>
  );
}

export function ChatScreen() {
  const init = useChatStore((s) => s.init);
  const transcript = useChatStore((s) => s.transcript);
  const busy = useChatStore((s) => s.busy);
  const pending = useChatStore((s) => s.pendingUserMessage);
  const liveTurn = useChatStore((s) => s.liveTurn);
  const send = useChatStore((s) => s.send);

  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void init();
  }, [init]);

  const turns: ChatTurn[] = transcript?.turns ?? [];

  // Show the optimistic user message unless the real transcript already ends
  // with it (avoids a flash of the message appearing twice).
  const lastTurn = turns[turns.length - 1];
  const lastIsPendingUser =
    lastTurn?.message.role === 'user' &&
    lastTurn.message.blocks
      .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim() === pending;
  const showPending = pending != null && !lastIsPendingUser;

  const liveBlockCount = liveTurn?.blocks.length ?? 0;
  const liveHasContent = liveBlockCount > 0;

  // Keep the newest content in view as the transcript grows or streams.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, busy, showPending, liveBlockCount]);

  const submit = (): void => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    void send(text);
    textareaRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <SessionList />

      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
            {turns.length === 0 && !busy ? <EmptyConversation /> : null}

            {turns.map((turn) => (
              <ChatTurnView key={turn.id} turn={turn} />
            ))}

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

            {/* The assistant's reply, streaming in live. */}
            {liveHasContent ? (
              <AssistantBlocks blocks={liveTurn!.blocks} />
            ) : null}

            {/* Only show the thinking indicator before any content has streamed. */}
            {busy && !liveHasContent ? (
              <div
                className={cn('flex items-center gap-2 text-[13px]', textMuted)}
              >
                <Spinner size="xs" label={null} />
                Thinking…
              </div>
            ) : null}
          </div>
        </div>

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
              disabled={draft.trim().length === 0 || busy}
              icon={busy ? undefined : ArrowUp}
              loading={busy}
              onClick={submit}
              className="mb-px shrink-0 rounded-full"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default ChatScreen;
