/**
 * Left rail: the bot list.
 */
import { Plus, Moon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui';
import { textSubtle } from '../../components/ui/styles';
import { useNow } from '../../hooks/useNow';
import {
  useBotList,
  useBotsStore,
  useSettingsStore,
  type RosterBot,
} from '../../store';
import type { BotMessage } from '../../../shared/bots';
import { BotOrb } from './colors';

/**
 * A bot is "asleep" after the configured idle window with no activity. Derived
 * on the client from the last message time — no server state needed. A run in
 * flight (unread streaming) is never asleep. Waking is automatic on the next
 * message, so this is purely an indicator.
 */
function isAsleep(
  lastAt: string | null,
  now: number,
  sleepAfterMinutes: number,
): boolean {
  if (!lastAt) return false;
  const t = new Date(lastAt).getTime();
  if (Number.isNaN(t)) return false;
  return now - t > sleepAfterMinutes * 60_000;
}

function compactRelative(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const mins = Math.round((now - date.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function firstText(blocks: BotMessage['blocks']): string {
  return blocks
    .filter(
      (block): block is Extract<(typeof blocks)[number], { kind: 'text' }> =>
        block.kind === 'text',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function previewFor(
  bot: RosterBot,
  messages: BotMessage[] | undefined,
): { preview: string; at: string | null } {
  if (bot.lastMessagePreview) {
    return {
      preview: bot.lastMessagePreview,
      at: bot.lastMessageAt ?? null,
    };
  }
  const last = messages?.[messages.length - 1];
  if (!last) return { preview: '', at: null };
  return { preview: firstText(last.blocks), at: last.createdAt };
}

export function BotRoster({ onCreate }: { onCreate: () => void }) {
  const bots = useBotList();
  const selectedBotId = useBotsStore((state) => state.selectedBotId);
  const selectBot = useBotsStore((state) => state.selectBot);
  const messagesByBot = useBotsStore((state) => state.messagesByBot);
  const sleepAfterMinutes = useSettingsStore(
    (state) => state.settings.bots.sleepAfterMinutes,
  );
  // Tick often enough that the sleep threshold (as low as 1 min) is timely.
  const now = useNow(20_000, bots.length > 0);

  return (
    <div className="flex w-60 shrink-0 flex-col border-r border-zinc-200/60 [-webkit-app-region:no-drag] dark:border-zinc-800/60">
      <div className="flex items-center justify-between gap-2 px-3 py-1">
        <h1 className="text-[13px] font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">
          Bots
        </h1>
        <Button
          size="icon"
          variant="ghost"
          icon={Plus}
          aria-label="Create bot"
          onClick={onCreate}
          className="h-11 w-11 shrink-0"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {bots.length === 0 ? (
          <p className={cn('px-1 py-2 text-[12px]', textSubtle)}>
            No bots yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {bots.map((bot) => {
              const { preview, at } = previewFor(bot, messagesByBot[bot.id]);
              const selected = bot.id === selectedBotId;
              const unread = bot.unread > 0;
              // Unread means something just arrived, so it is awake regardless.
              const asleep = !unread && isAsleep(at, now, sleepAfterMinutes);
              return (
                <li key={bot.id}>
                  <button
                    type="button"
                    onClick={() => {
                      void selectBot(bot.id);
                    }}
                    aria-current={selected ? 'true' : undefined}
                    aria-label={unread ? `${bot.name}, unread` : bot.name}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-[12.5px] transition-colors',
                      selected
                        ? 'bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-zinc-700'
                        : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/60',
                    )}
                  >
                    <BotOrb
                      color={bot.avatarColor}
                      size={20}
                      className={cn('mt-0.5', asleep && 'opacity-40')}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate font-medium',
                            asleep && 'text-zinc-500 dark:text-zinc-500',
                          )}
                        >
                          {bot.name}
                        </span>
                        {asleep ? (
                          <Moon
                            size={11}
                            aria-label="asleep"
                            className="shrink-0 text-zinc-400 dark:text-zinc-500"
                          />
                        ) : null}
                        {at ? (
                          <span
                            className={cn(
                              'shrink-0 text-[11px] tabular-nums',
                              textSubtle,
                            )}
                          >
                            {compactRelative(at, now)}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-[11px]',
                            textSubtle,
                          )}
                        >
                          {preview || '\u00a0'}
                        </span>
                        <span
                          className={cn(
                            'h-2 w-2 shrink-0 rounded-full',
                            unread ? 'bg-indigo-500' : 'bg-transparent',
                          )}
                          aria-hidden
                        />
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default BotRoster;
