import { Check } from 'lucide-react';
import { Section } from './Section';
import { REMINDERS } from '../data';

const PRIORITY_DOT: Record<string, string> = {
  high: 'bg-rose-400/80',
  medium: 'bg-amber-400/80',
  low: 'bg-white/20',
};

export function RemindersCard() {
  return (
    <Section label="Reminders">
      <ul className="space-y-3">
        {REMINDERS.map((reminder) => (
          <li key={reminder.id} className="group flex items-baseline gap-3">
            {reminder.done ? (
              <Check
                size={12}
                className="shrink-0 translate-y-0.5 text-emerald-400/70"
                aria-hidden="true"
              />
            ) : (
              <span
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[reminder.priority]}`}
                aria-hidden="true"
              />
            )}
            <span
              className={`min-w-0 flex-1 truncate text-[13px] ${
                reminder.done
                  ? 'text-white/25 line-through'
                  : 'text-white/75 transition-colors group-hover:text-white/95'
              }`}
            >
              {reminder.title}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-white/30">
              {reminder.due}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export default RemindersCard;
