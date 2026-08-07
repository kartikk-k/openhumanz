import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  TONE_DOT,
  TONE_OUTLINE,
  TONE_SOFT,
  TONE_SOLID,
  type Tone,
} from '../../lib/tone';

export type BadgeVariant = 'soft' | 'solid' | 'outline';

const VARIANT_TONES: Record<BadgeVariant, Record<Tone, string>> = {
  soft: TONE_SOFT,
  solid: TONE_SOLID,
  outline: TONE_OUTLINE,
};

export interface BadgeProps {
  tone?: Tone;
  variant?: BadgeVariant;
  size?: 'sm' | 'md';
  icon?: LucideIcon;
  /** Renders a status dot before the label instead of an icon. */
  dot?: boolean;
  className?: string;
  title?: string;
  children: ReactNode;
}

/**
 * Compact status/metadata chip. Not a button — if it is clickable it is a
 * Button with `size="xs"`.
 */
export function Badge({
  tone = 'neutral',
  variant = 'soft',
  size = 'sm',
  icon: Icon,
  dot = false,
  className,
  title,
  children,
}: BadgeProps) {
  const toneClass = VARIANT_TONES[variant][tone];

  return (
    <span
      title={title}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded font-medium',
        size === 'sm' ? 'h-[18px] px-1.5 text-[11px]' : 'h-6 px-2 text-xs',
        toneClass,
        className,
      )}
    >
      {dot && (
        <span
          className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[tone])}
          aria-hidden="true"
        />
      )}
      {!dot && Icon && (
        <Icon
          size={size === 'sm' ? 11 : 13}
          strokeWidth={2.25}
          aria-hidden="true"
        />
      )}
      <span className="truncate">{children}</span>
    </span>
  );
}

export interface StatusDotProps {
  tone?: Tone;
  /** Adds a soft ping halo. Use only for genuinely live things. */
  pulse?: boolean;
  size?: 'sm' | 'md';
  /**
   * Accessible label. Rendered visually hidden — a dot alone is meaningless to
   * a screen reader. Pass `null` when adjacent text already says it.
   */
  label?: string | null;
  className?: string;
}

/** A 6px coloured dot. The densest possible status indicator. */
export function StatusDot({
  tone = 'neutral',
  pulse = false,
  size = 'sm',
  label = null,
  className,
}: StatusDotProps) {
  const px = size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2';
  return (
    <span className={cn('relative inline-flex shrink-0', px, className)}>
      {pulse && (
        <span
          className={cn(
            'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60',
            TONE_DOT[tone],
          )}
          aria-hidden="true"
        />
      )}
      <span
        className={cn('relative inline-flex rounded-full', px, TONE_DOT[tone])}
        aria-hidden={label ? undefined : true}
        role={label ? 'img' : undefined}
        aria-label={label ?? undefined}
      />
    </span>
  );
}

export default Badge;
