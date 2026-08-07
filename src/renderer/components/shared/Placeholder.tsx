import type { ReactNode } from 'react';
import { Construction } from 'lucide-react';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { eyebrow } from '../ui/styles';

export interface PlaceholderProps {
  /** What this screen will be, in one sentence. */
  summary: ReactNode;
  /** The file that should be replaced — shown verbatim so it is unambiguous. */
  filePath: string;
  /** IPC channels this screen is expected to use, from `src/shared/ipc.ts`. */
  channels?: readonly string[];
  /** Push channels it should subscribe to or refetch on. */
  pushChannels?: readonly string[];
  /** The bullet list of what the screen has to do. */
  requirements?: readonly ReactNode[];
  /** Anything else worth rendering below the brief. */
  children?: ReactNode;
}

/**
 * A deliberate, marked stand-in for a screen another agent will build.
 *
 * It states the contract — file to replace, channels to use, what the surface
 * has to do — so the brief travels with the code rather than in a hand-off
 * message.
 */
export function Placeholder({
  summary,
  filePath,
  channels,
  pushChannels,
  requirements,
  children,
}: PlaceholderProps) {
  return (
    <div className="mx-auto max-w-3xl px-5 py-6">
      <Card variant="ghost" className="p-5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500">
            <Construction size={16} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Badge tone="warning" variant="soft">
                Placeholder
              </Badge>
              <span className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                {filePath}
              </span>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300">
              {summary}
            </p>

            {requirements && requirements.length > 0 ? (
              <ul className="mt-3 space-y-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                {requirements.map((requirement, index) => (
                  <li
                    // Static copy; index is a stable key here.
                    // eslint-disable-next-line react/no-array-index-key
                    key={index}
                    className="flex gap-2"
                  >
                    <span
                      aria-hidden="true"
                      className="text-zinc-300 dark:text-zinc-600"
                    >
                      —
                    </span>
                    <span>{requirement}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {channels && channels.length > 0 ? (
              <div className="mt-4">
                <p className={eyebrow}>Channels</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {channels.map((channel) => (
                    <code
                      key={channel}
                      className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                    >
                      {channel}
                    </code>
                  ))}
                </div>
              </div>
            ) : null}

            {pushChannels && pushChannels.length > 0 ? (
              <div className="mt-3">
                <p className={eyebrow}>Push</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {pushChannels.map((channel) => (
                    <code
                      key={channel}
                      className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                    >
                      {channel}
                    </code>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </Card>
      {children}
    </div>
  );
}

export default Placeholder;
