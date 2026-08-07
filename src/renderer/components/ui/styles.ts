/**
 * Shared class fragments for the primitives.
 *
 * Not a theme system — just the handful of strings that must be identical
 * everywhere or the UI stops looking like one product.
 */

/** Keyboard focus ring. Applied to every interactive primitive. */
export const focusRing =
  'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-offset-zinc-950';

/** Focus ring for elements that sit directly on a panel (no offset). */
export const focusRingInset =
  'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500';

/** The 1px divider colour used for every border in the app. */
export const hairline = 'border-zinc-200 dark:border-zinc-800';

/** Raised panel: cards, popovers, dialogs. */
export const surface =
  'bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800';

/** Recessed panel: sidebars, toolbars, table headers. */
export const surfaceMuted = 'bg-zinc-50 dark:bg-zinc-900/60';

/** Text scale. */
export const textMuted = 'text-zinc-500 dark:text-zinc-400';
export const textSubtle = 'text-zinc-600 dark:text-zinc-400';
export const textStrong = 'text-zinc-900 dark:text-zinc-100';

/** Small-caps section label used above groups of controls. */
export const eyebrow =
  'text-[11px] font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-500';

/** Monospace stack for ids, paths, commands and raw payloads. */
export const mono = 'font-mono text-[12px] tabular-nums';
