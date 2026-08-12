import { Check, X } from 'lucide-react';
import { Section } from './Section';
import { COMPLETED_TASKS } from '../data';

export function CompletedTasksCard() {
  return (
    <Section label="Done recently">
      <ul className="space-y-3">
        {COMPLETED_TASKS.map((task) => (
          <li key={task.id} className="flex items-baseline gap-3">
            {task.outcome === 'success' ? (
              <Check
                size={12}
                className="shrink-0 translate-y-0.5 text-emerald-400/60"
                aria-hidden="true"
              />
            ) : (
              <X
                size={12}
                className="shrink-0 translate-y-0.5 text-rose-400/60"
                aria-hidden="true"
              />
            )}
            <span className="min-w-0 flex-1 truncate text-[13px] text-white/55">
              {task.title}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-white/25">
              {task.finishedAt}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export default CompletedTasksCard;
