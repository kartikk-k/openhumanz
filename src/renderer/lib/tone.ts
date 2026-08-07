/**
 * The six semantic tones, and the Tailwind class sets that render them.
 *
 * Every coloured surface in the app resolves through this file. Feature screens
 * pick a `Tone`; they never pick a Tailwind colour. That is the whole reason
 * the palette stays restrained as five people add screens to it.
 *
 *   neutral  resting state, counts, metadata
 *   accent   the app's own colour — primary actions, active nav
 *   info     in progress, running, live
 *   success  finished well
 *   warning  waiting on a human, skipped, degraded
 *   danger   failed, destructive, denied
 */
export type Tone =
  'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'danger';

export const TONES: readonly Tone[] = [
  'neutral',
  'accent',
  'info',
  'success',
  'warning',
  'danger',
];

/** Filled chip: high contrast, use sparingly. */
export const TONE_SOLID: Record<Tone, string> = {
  neutral: 'bg-zinc-800 text-zinc-50 dark:bg-zinc-200 dark:text-zinc-900',
  accent: 'bg-indigo-600 text-white dark:bg-indigo-500',
  info: 'bg-sky-600 text-white dark:bg-sky-500',
  success: 'bg-emerald-600 text-white dark:bg-emerald-500',
  warning: 'bg-amber-500 text-amber-950 dark:bg-amber-400',
  danger: 'bg-rose-600 text-white dark:bg-rose-500',
};

/** Tinted chip. The default badge look. */
export const TONE_SOFT: Record<Tone, string> = {
  neutral: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  accent:
    'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
  info: 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  success:
    'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  warning:
    'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  danger: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
};

/** Hairline chip. Reads as metadata rather than status. */
export const TONE_OUTLINE: Record<Tone, string> = {
  neutral:
    'border border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400',
  accent:
    'border border-indigo-300 text-indigo-700 dark:border-indigo-500/40 dark:text-indigo-300',
  info: 'border border-sky-300 text-sky-700 dark:border-sky-500/40 dark:text-sky-300',
  success:
    'border border-emerald-300 text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-300',
  warning:
    'border border-amber-300 text-amber-800 dark:border-amber-500/40 dark:text-amber-300',
  danger:
    'border border-rose-300 text-rose-700 dark:border-rose-500/40 dark:text-rose-300',
};

/** Background for a 6px status dot. */
export const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-zinc-400 dark:bg-zinc-500',
  accent: 'bg-indigo-500',
  info: 'bg-sky-500',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-rose-500',
};

/** Foreground colour only — for icons and inline text. */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-zinc-500 dark:text-zinc-400',
  accent: 'text-indigo-600 dark:text-indigo-400',
  info: 'text-sky-600 dark:text-sky-400',
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-rose-600 dark:text-rose-400',
};
