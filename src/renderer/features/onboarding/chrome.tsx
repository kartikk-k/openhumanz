/**
 * The furniture every onboarding step sits in.
 *
 * The flow is five screens, and the shared vocabulary between them is small on
 * purpose: a numbered rail so you always know how much is left, a heading and
 * one sentence of context, the step's own content, and a footer that either
 * lets you continue or says — in a full sentence — why not.
 *
 * The rule the whole flow is built to: **never a dead end**. Every step that
 * can block also offers a way past itself, and the header's escape hatch is
 * present on all five.
 */
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Check, CircleAlert } from 'lucide-react';
import type { OnboardingStep } from '../../../shared/settings';
import { cn } from '../../lib/utils';
import { textMuted, textSubtle } from '../../components/ui/styles';

/* ------------------------------------------------------------------ */
/* The flow                                                            */
/* ------------------------------------------------------------------ */

export interface FlowStep {
  id: OnboardingStep;
  /** Short label for the rail. */
  label: string;
  /** Heading on the step itself. */
  title: string;
  /** One line under the heading. */
  blurb: string;
}

/**
 * Five steps, in order.
 *
 * The ids come from `ONBOARDING_STEPS` in `shared/settings.ts` and are fixed,
 * so the fourth is called `permissions` even though what it actually asks for
 * is a first data source — which on this platform means the memory vault, plus
 * an honest account of which OS sources are reachable at all. Same screen,
 * older name.
 */
export const FLOW: readonly FlowStep[] = [
  {
    id: 'welcome',
    label: 'Welcome',
    title: 'An assistant that runs on your machine',
    blurb: 'What this is, and what it deliberately is not.',
  },
  {
    id: 'engine',
    label: 'Engine',
    title: 'Find the agent CLI',
    blurb: 'The app orchestrates. Your CLI, signed in as you, does the work.',
  },
  {
    id: 'workspace',
    label: 'Workspace',
    title: 'Choose where your data lives',
    blurb: 'One folder. Plain files. Yours to open, move or delete.',
  },
  {
    id: 'permissions',
    label: 'Data source',
    title: 'Give it something to remember',
    blurb: 'Point the memory vault at a folder of notes.',
  },
  {
    id: 'done',
    label: 'First run',
    title: 'Run one task',
    blurb: 'Finish on proof rather than a promise.',
  },
];

export function stepIndex(step: OnboardingStep): number {
  const index = FLOW.findIndex((entry) => entry.id === step);
  return index === -1 ? 0 : index;
}

/* ------------------------------------------------------------------ */
/* Rail                                                                */
/* ------------------------------------------------------------------ */

export function Stepper({
  current,
  onJump,
}: {
  current: OnboardingStep;
  /** Jumping back is always allowed; jumping forward is not. */
  onJump: (step: OnboardingStep) => void;
}) {
  const currentIndex = stepIndex(current);

  return (
    <ol
      className="flex flex-wrap items-center gap-1.5"
      aria-label="Setup steps"
    >
      {FLOW.map((entry, index) => {
        const done = index < currentIndex;
        const active = index === currentIndex;
        return (
          <li key={entry.id} className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={!done && !active}
              onClick={() => onJump(entry.id)}
              aria-current={active ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-2 py-1 text-[11.5px] font-medium transition-colors',
                'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
                active &&
                  'bg-indigo-600 text-white dark:bg-indigo-500 dark:text-white',
                done &&
                  'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
                !active &&
                  !done &&
                  'cursor-default text-zinc-400 dark:text-zinc-600',
              )}
            >
              <span
                className={cn(
                  'flex h-4 w-4 items-center justify-center rounded-full text-[10px] tabular-nums',
                  active && 'bg-white/25',
                  done &&
                    'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
                  !active && !done && 'bg-zinc-100 dark:bg-zinc-800',
                )}
              >
                {done ? <Check size={10} aria-hidden="true" /> : index + 1}
              </span>
              {entry.label}
            </button>
            {index < FLOW.length - 1 ? (
              <span
                aria-hidden="true"
                className="h-px w-3 bg-zinc-200 dark:bg-zinc-800"
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* Step body                                                           */
/* ------------------------------------------------------------------ */

export function StepShell({
  step,
  icon: Icon,
  children,
}: {
  step: FlowStep;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-8">
      <div className="flex items-start gap-3">
        {Icon ? (
          <span className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-400">
            <Icon size={17} aria-hidden="true" />
          </span>
        ) : null}
        <div className="min-w-0">
          <h2 className="text-[19px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            {step.title}
          </h2>
          <p className={cn('mt-1 text-[13px] leading-relaxed', textSubtle)}>
            {step.blurb}
          </p>
        </div>
      </div>
      <div className="mt-6 space-y-4">{children}</div>
    </div>
  );
}

/**
 * The reason the primary button is off. A sentence, never a shrug — and it is
 * rendered next to a way past it, not instead of one.
 */
export function BlockedReason({ children }: { children: ReactNode }) {
  return (
    <p
      className={cn(
        'flex items-start gap-1.5 text-[12px] leading-relaxed',
        textMuted,
      )}
    >
      <CircleAlert size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** A short list of plain facts, used on the welcome step. */
export function FactList({
  items,
}: {
  items: readonly { icon: LucideIcon; title: string; body: string }[];
}) {
  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item.title} className="flex gap-3">
          <item.icon
            size={16}
            aria-hidden="true"
            className="mt-0.5 shrink-0 text-indigo-600 dark:text-indigo-400"
          />
          <div>
            <p className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
              {item.title}
            </p>
            <p
              className={cn('mt-0.5 text-[12.5px] leading-relaxed', textSubtle)}
            >
              {item.body}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
