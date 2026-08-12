import { Section } from './Section';
import { WORKFLOWS } from '../data';

const LAST_RUN_TONE: Record<string, string> = {
  success: 'text-emerald-400/70',
  failed: 'text-rose-400/70',
  never: 'text-white/25',
};

export function WorkflowsCard() {
  return (
    <Section label="Workflows">
      <ul className="space-y-3">
        {WORKFLOWS.map((workflow) => (
          <li key={workflow.id} className="group flex items-baseline gap-3">
            <span
              className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                workflow.status === 'active'
                  ? 'bg-emerald-400/80'
                  : 'bg-white/20'
              }`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] text-white/80 transition-colors group-hover:text-white/95">
                {workflow.name}
              </p>
              <p className="text-[11px] text-white/30">
                {workflow.schedule} · next {workflow.nextRun}
              </p>
            </div>
            <span
              className={`shrink-0 text-[11px] capitalize ${LAST_RUN_TONE[workflow.lastRun]}`}
            >
              {workflow.lastRun}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export default WorkflowsCard;
