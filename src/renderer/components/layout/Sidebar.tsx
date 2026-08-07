import { NavLink } from 'react-router-dom';
import { CircleDashed, Cpu } from 'lucide-react';
import { cn } from '../../lib/utils';
import { NAV_ITEMS, ROUTES } from '../../routes';
import { APP_NAME } from '../../constants';
import { focusRing } from '../ui/styles';
import { Tooltip } from '../ui/Tooltip';
import { StatusDot } from '../ui/Badge';
import {
  usePendingApprovalCount,
  useEnvironment,
  usePreferredEngine,
  useSettingsStore,
} from '../../store';

function ApprovalsBadge() {
  const count = usePendingApprovalCount();
  if (count === 0) return null;
  return (
    <span
      className="ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold tabular-nums text-amber-950"
      aria-label={`${count} waiting for you`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/** Engine availability, bottom of the sidebar. Quiet unless something is wrong. */
function EngineStatus() {
  const environment = useEnvironment();
  const preferredId = useSettingsStore(
    (state) => state.settings.engine.preferred,
  );
  const engine = usePreferredEngine(preferredId);

  if (!environment) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
        <CircleDashed size={12} aria-hidden="true" />
        Checking environment…
      </div>
    );
  }

  const available = Boolean(engine?.available);
  const label = engine?.name ?? 'No engine';

  return (
    <Tooltip
      side="top"
      content={
        available
          ? `${label}${engine?.version ? ` ${engine.version}` : ''} — ready`
          : (engine?.reason ?? 'No agent CLI was detected on this machine.')
      }
    >
      <span className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
        <StatusDot tone={available ? 'success' : 'danger'} label={null} />
        <Cpu size={12} aria-hidden="true" className="shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    </Tooltip>
  );
}

/**
 * Persistent left rail.
 *
 * Fixed width, always visible — this is a desktop tool and the destinations do
 * not change, so a collapsible drawer would only add a decision to make.
 */
export function Sidebar() {
  return (
    <nav
      aria-label="Primary"
      className="flex w-[188px] shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/50"
    >
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <span
          aria-hidden="true"
          className="flex h-5 w-5 items-center justify-center rounded bg-indigo-600 text-[10px] font-bold text-white"
        >
          A
        </span>
        <span className="truncate text-[13px] font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">
          {APP_NAME}
        </span>
      </div>

      <ul className="flex flex-1 flex-col gap-0.5 px-2 py-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.key}>
              <NavLink
                to={item.path}
                title={item.description}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors',
                    focusRing,
                    isActive
                      ? 'bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-zinc-700'
                      : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-100',
                  )
                }
              >
                <Icon size={15} aria-hidden="true" className="shrink-0" />
                <span className="truncate">{item.label}</span>
                {item.badge === 'approvals' ? <ApprovalsBadge /> : null}
              </NavLink>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-zinc-200 px-2 py-2 dark:border-zinc-800">
        <EngineStatus />
        <NavLink
          to={ROUTES.onboarding}
          className={cn(
            'block rounded px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300',
            focusRing,
          )}
        >
          Setup guide
        </NavLink>
      </div>
    </nav>
  );
}

export default Sidebar;
