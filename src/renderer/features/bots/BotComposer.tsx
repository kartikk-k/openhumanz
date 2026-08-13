/**
 * Thread composer. Enter sends; Shift+Enter is a newline. Sending kicks a
 * background run — this never cancels when the user switches bots.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { Button } from '../../components/ui';
import { useBotsStore, useSelectedBot } from '../../store';

export function BotComposer() {
  const bot = useSelectedBot();
  const send = useBotsStore((state) => state.send);
  const sending = useBotsStore((state) => state.sending);
  const selectedBotId = useBotsStore((state) => state.selectedBotId);

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draft = selectedBotId ? (drafts[selectedBotId] ?? '') : '';

  useEffect(() => {
    textareaRef.current?.focus();
  }, [selectedBotId]);

  if (!bot || !selectedBotId) return null;

  const setDraft = (value: string) => {
    setDrafts((previous) => ({ ...previous, [selectedBotId]: value }));
  };

  const submit = (): void => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft('');
    void send(text);
    textareaRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="shrink-0 border-t border-zinc-200/60 px-4 py-3 dark:border-zinc-800/60">
      <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
        <div className="flex min-h-[44px] flex-1 items-end rounded-2xl border border-zinc-300 bg-white/70 px-3 py-2 focus-within:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-900/50">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={`Message ${bot.name}…  (Enter to send, Shift+Enter for a new line)`}
            className="max-h-40 flex-1 resize-none bg-transparent text-[13.5px] leading-relaxed text-zinc-800 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />
        </div>
        <Button
          size="icon"
          variant="primary"
          aria-label="Send"
          disabled={draft.trim().length === 0 || sending}
          icon={sending ? undefined : ArrowUp}
          loading={sending}
          onClick={submit}
          className="mb-px h-11 w-11 shrink-0 rounded-full"
        />
      </div>
    </div>
  );
}

export default BotComposer;
