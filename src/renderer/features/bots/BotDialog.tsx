/**
 * Create or edit a bot. Name, avatar colour, optional system prompt.
 */
import { useEffect, useState } from 'react';
import { cn } from '../../lib/utils';
import { Button, Dialog, Input, Textarea } from '../../components/ui';
import { useBotsStore, type RosterBot } from '../../store';
import { AVATAR_COLORS, BotOrb, DEFAULT_AVATAR_COLOR } from './colors';

export interface BotDialogProps {
  open: boolean;
  /** When set, the dialog edits this bot; otherwise it creates one. */
  bot?: RosterBot | null;
  onClose: () => void;
}

interface Draft {
  name: string;
  avatarColor: string;
  systemPrompt: string;
}

function emptyDraft(): Draft {
  return { name: '', avatarColor: DEFAULT_AVATAR_COLOR, systemPrompt: '' };
}

function draftFrom(bot: RosterBot): Draft {
  return {
    name: bot.name,
    avatarColor: bot.avatarColor || DEFAULT_AVATAR_COLOR,
    systemPrompt: bot.systemPrompt,
  };
}

export function BotDialog({ open, bot, onClose }: BotDialogProps) {
  const createBot = useBotsStore((state) => state.createBot);
  const updateBot = useBotsStore((state) => state.updateBot);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const editing = Boolean(bot);

  useEffect(() => {
    if (!open) return;
    setDraft(bot ? draftFrom(bot) : emptyDraft());
    setFailure(null);
    setPending(false);
    // Identity of `bot` changes on every roster refresh; key off the id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bot?.id]);

  const patch = (next: Partial<Draft>) =>
    setDraft((previous) => ({ ...previous, ...next }));

  const submit = async () => {
    const name = draft.name.trim();
    if (!name || pending) return;
    setPending(true);
    setFailure(null);

    const saved = bot
      ? await updateBot({
          id: bot.id,
          name,
          avatarColor: draft.avatarColor,
          systemPrompt: draft.systemPrompt,
        })
      : await createBot({
          name,
          avatarColor: draft.avatarColor,
          systemPrompt: draft.systemPrompt,
        });

    setPending(false);
    if (!saved) {
      const error = useBotsStore.getState().error;
      const unavailable = useBotsStore.getState().unavailable;
      setFailure(
        unavailable
          ? 'Not connected to the backend, so the bot was not saved. Nothing was lost — the form is still here.'
          : (error ?? 'The bot could not be saved.'),
      );
      return;
    }
    onClose();
  };

  const isTouch = typeof window !== 'undefined' && 'ontouchstart' in window;

  return (
    <Dialog
      open={open}
      onClose={pending ? () => {} : onClose}
      size="md"
      title={editing ? 'Edit bot' : 'New bot'}
      description={
        editing
          ? 'Rename this bot, change its colour, or update its instructions.'
          : 'A named agent with its own thread. You can talk to it from the roster.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={!draft.name.trim()}
            onClick={() => {
              void submit();
            }}
          >
            {editing ? 'Save' : 'Create bot'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {failure ? (
          <p className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300">
            {failure}
          </p>
        ) : null}

        <div className="flex items-end gap-3">
          <BotOrb color={draft.avatarColor} size={32} className="mb-0.5" />
          <div className="min-w-0 flex-1">
            <Input
              label="Name"
              required
              value={draft.name}
              placeholder="Hacker News"
              autoFocus={!isTouch}
              spellCheck={false}
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              onChange={(event) => patch({ name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Color
          </p>
          <div
            role="radiogroup"
            aria-label="Avatar color"
            className="flex flex-wrap gap-0.5"
          >
            {AVATAR_COLORS.map((swatch) => {
              const selected = draft.avatarColor === swatch.value;
              return (
                <button
                  key={swatch.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={swatch.label}
                  onClick={() => patch({ avatarColor: swatch.value })}
                  className={cn(
                    'flex h-11 w-11 items-center justify-center rounded-md',
                    selected &&
                      'ring-2 ring-indigo-500 ring-offset-1 dark:ring-offset-zinc-900',
                  )}
                >
                  <span
                    className="h-6 w-6 rounded-full"
                    style={{ backgroundColor: swatch.value }}
                  />
                </button>
              );
            })}
          </div>
        </div>

        <Textarea
          label="System prompt"
          hint="Optional. Prepended to every turn so the agent speaks as this bot."
          rows={4}
          value={draft.systemPrompt}
          placeholder="You are a concise researcher. Summarise, then list sources."
          spellCheck={false}
          onChange={(event) => patch({ systemPrompt: event.target.value })}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </div>
    </Dialog>
  );
}

export default BotDialog;
