/**
 * Chat tab: a Slack-like roster of bots on the left, the selected bot's
 * thread and composer on the right. Main is first and cannot be archived.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { MessageSquare } from 'lucide-react';
import { ConfirmDialog, EmptyState } from '../../components/ui';
import { useBotsStore, useSelectedBot } from '../../store';
import { BotComposer } from './BotComposer';
import { BotDialog } from './BotDialog';
import { BotRoster } from './BotRoster';
import { BotThread, BotThreadHeader } from './BotThread';

export function BotsScreen() {
  const loadRoster = useBotsStore((state) => state.loadRoster);
  const archiveBot = useBotsStore((state) => state.archiveBot);
  const selectedBotId = useBotsStore((state) => state.selectedBotId);
  const status = useBotsStore((state) => state.status);
  const unavailable = useBotsStore((state) => state.unavailable);
  const error = useBotsStore((state) => state.error);
  const bot = useSelectedBot();

  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  useEffect(() => {
    const onFocus = () => {
      const id = useBotsStore.getState().selectedBotId;
      if (id) void useBotsStore.getState().markRead(id);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const emptyUnavailable =
    unavailable && !selectedBotId && status !== 'loading';

  let thread: ReactNode;
  if (emptyUnavailable) {
    thread = (
      <EmptyState
        icon={MessageSquare}
        title="Bots are not available yet."
        description={
          error ??
          'The backend has not registered this screen. The roster will appear once it is wired.'
        }
      />
    );
  } else if (bot) {
    thread = (
      <>
        <BotThreadHeader
          onRename={() => setEditOpen(true)}
          onArchive={() => setArchiveOpen(true)}
        />
        {status === 'error' && error && !unavailable ? (
          <p className="shrink-0 border-b border-zinc-200/60 px-4 py-2 text-[12px] text-rose-600 dark:border-zinc-800/60 dark:text-rose-400">
            {error}
          </p>
        ) : null}
        <BotThread />
        <BotComposer />
      </>
    );
  } else {
    thread = (
      <EmptyState
        icon={MessageSquare}
        title="Select a bot"
        description="Pick one from the list, or create a new bot to start a thread."
        size="sm"
      />
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <BotRoster onCreate={() => setCreateOpen(true)} />

      <div className="flex min-w-0 flex-1 flex-col">{thread}</div>

      <BotDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <BotDialog open={editOpen} bot={bot} onClose={() => setEditOpen(false)} />
      <ConfirmDialog
        open={archiveOpen}
        title={bot ? `Archive ${bot.name}?` : 'Archive this bot?'}
        description="It will leave the roster. Its thread is kept."
        confirmLabel="Archive"
        tone="danger"
        onConfirm={async () => {
          if (!bot) return;
          const ok = await archiveBot(bot.id);
          if (ok) setArchiveOpen(false);
        }}
        onCancel={() => setArchiveOpen(false)}
      />
    </div>
  );
}

export default BotsScreen;
