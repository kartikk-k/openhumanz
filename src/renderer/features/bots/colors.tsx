import { cn } from '../../lib/utils';

/** Preset avatar colours. First entry is the create-dialog default (indigo). */
export const AVATAR_COLORS = [
  { value: '#6366f1', label: 'Indigo' },
  { value: '#8b5cf6', label: 'Violet' },
  { value: '#ec4899', label: 'Pink' },
  { value: '#f43f5e', label: 'Rose' },
  { value: '#f59e0b', label: 'Amber' },
  { value: '#10b981', label: 'Emerald' },
  { value: '#14b8a6', label: 'Teal' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#64748b', label: 'Slate' },
] as const;

export const DEFAULT_AVATAR_COLOR = AVATAR_COLORS[0].value;

export function BotOrb({
  color,
  size = 20,
  className,
}: {
  color: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn('inline-block shrink-0 rounded-full', className)}
      style={{
        width: size,
        height: size,
        backgroundColor: color || DEFAULT_AVATAR_COLOR,
      }}
    />
  );
}
