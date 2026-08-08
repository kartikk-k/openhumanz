/**
 * Step 1 — what this is, said honestly.
 *
 * The positioning is the product, so it is stated here before anything is
 * configured: user-owned, no account, no backend of ours, offline for
 * everything that does not inherently need a network. Claims that only appear
 * in a README are claims nobody reads.
 */
import { FolderOpen, Laptop, Lock, ShieldCheck, WifiOff } from 'lucide-react';
import { APP_NAME, DEFAULT_WORKSPACE_HINT } from '../../constants';
import { cn } from '../../lib/utils';
import { textSubtle } from '../../components/ui/styles';
import { FactList } from './chrome';

const FACTS = [
  {
    icon: Laptop,
    title: 'It runs here, not somewhere else',
    body: `${APP_NAME} is a window and a folder on this disk. It orchestrates the agent CLI you already have installed, signed in as you, using your own subscription.`,
  },
  {
    icon: Lock,
    title: 'No account, no telemetry, no backend of ours',
    body: 'Nothing to sign up for. No analytics, no crash reporting, no licence check, no server we operate. There is no product here that could collect anything from you.',
  },
  {
    icon: WifiOff,
    title: 'Offline for everything that does not need a network',
    body: 'Your notes, tasks, schedules, run history and memory search all work with the network off. The only traffic this app causes is your CLI talking to its own vendor — the same call you would make in a terminal.',
  },
  {
    icon: FolderOpen,
    title: 'Plain files you can open',
    body: `Memory is Markdown. Transcripts are JSONL. Settings are JSON. Everything sits under ${DEFAULT_WORKSPACE_HINT} unless you move it, and nothing is locked in a format only this app understands.`,
  },
  {
    icon: ShieldCheck,
    title: 'It asks before it acts',
    body: 'Anything with a side effect — sending mail, changing a calendar, writing outside the workspace — stops at an approval card first. Every decision is logged with the full arguments.',
  },
] as const;

export function WelcomeStep() {
  return (
    <>
      <FactList items={FACTS} />
      <p
        className={cn(
          'rounded-md border border-dashed border-zinc-200 px-3 py-2.5 text-[12.5px] leading-relaxed dark:border-zinc-800',
          textSubtle,
        )}
      >
        Four short steps from here: find your CLI, pick a folder, point it at
        some notes, and run one real task. You will not need a terminal, and you
        will not need to edit a config file.
      </p>
    </>
  );
}

export default WelcomeStep;
