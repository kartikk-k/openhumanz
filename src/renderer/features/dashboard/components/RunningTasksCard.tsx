import { Section } from './Section';
import { RUNNING_TASKS } from '../data';

export function RunningTasksCard() {
  return (
    <Section label="Running now">
      <ul className="space-y-4">
        {RUNNING_TASKS.map((task) => (
          <li key={task.id} className="group">
            <div className="flex items-baseline gap-3">
              <span className="relative mt-1.5 flex size-1.5 shrink-0 self-start">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400/70" />
                <span className="relative inline-flex size-1.5 rounded-full bg-sky-400" />
              </span>
              <p className="min-w-0 flex-1 truncate text-[13px] text-white/80 transition-colors group-hover:text-white/95">
                {task.title}
              </p>
              <span className="shrink-0 text-[11px] tabular-nums text-white/40">
                {task.progress}%
              </span>
            </div>
            {/* Hairline progress — the one bar we keep, but flush to the text, no container. */}
            <div className="ml-[18px] mt-2 h-px bg-white/10">
              <div
                className="h-full bg-sky-400/70"
                style={{ width: `${task.progress}%` }}
              />
            </div>
            <p className="ml-[18px] mt-1.5 text-[11px] text-white/30">
              {task.detail}
            </p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export default RunningTasksCard;
