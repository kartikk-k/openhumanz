/**
 * `/approvals` and everything under it.
 *
 * The approval gate is the most important mechanism in the product, and this
 * screen is its face. It has three surfaces and they are deliberately three
 * *routes* rather than three panels on one page, because each answers a
 * different question and only one of them is urgent:
 *
 *   /approvals           what is waiting on me right now
 *   /approvals/grants    what have I already said yes to, and how do I undo it
 *   /approvals/history   what did I decide, and on what arguments
 *
 * The route is a splat, so the nested routing lives here and `App.tsx` never
 * has to learn about it.
 *
 * Pending approvals arrive by push and are applied by `store/bootstrap.ts`;
 * this screen does not re-subscribe to `approvalRequested` / `approvalResolved`.
 * Two listeners on one channel is how two sources of truth start disagreeing.
 * It reads the store, and writes through `resolve()`, which is optimistic and
 * rolls back on failure.
 */
import { useEffect, useMemo } from 'react';
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { History, KeyRound, RotateCcw, ShieldAlert, Inbox } from 'lucide-react';
import { ROUTES } from '../../routes';
import { pluralize } from '../../lib/format';
import { PageHeader } from '../../components/layout/PageHeader';
import { Badge, Button, Tabs } from '../../components/ui';
import { useApprovalsStore, useSettingsStore } from '../../store';
import { ApprovalQueue } from './ApprovalQueue';
import { GrantsPanel } from './GrantsPanel';
import { HistoryPanel } from './HistoryPanel';
import { NoticePanel, useNow } from './parts';

type ApprovalsTab = 'queue' | 'grants' | 'history';

const TAB_PATH: Record<ApprovalsTab, string> = {
  queue: ROUTES.approvals,
  grants: `${ROUTES.approvals}/grants`,
  history: `${ROUTES.approvals}/history`,
};

function tabForPath(pathname: string): ApprovalsTab {
  if (pathname.startsWith(TAB_PATH.grants)) return 'grants';
  if (pathname.startsWith(TAB_PATH.history)) return 'history';
  return 'queue';
}

export function ApprovalsScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  const tab = tabForPath(location.pathname);

  const now = useNow();

  const pendingCount = useApprovalsStore((state) => state.pending.length);
  const grantCount = useApprovalsStore((state) => state.grants.length);
  const status = useApprovalsStore((state) => state.status);
  const load = useApprovalsStore((state) => state.load);
  const loadGrants = useApprovalsStore((state) => state.loadGrants);

  const gateOn = useSettingsStore(
    (state) => state.settings.approvals.requireForSideEffecting,
  );

  // The shell loads the queue at startup. This covers the case where that
  // never happened — a direct mount in a test, or a load that failed before
  // this screen existed — without fighting the store when it is already good.
  useEffect(() => {
    if (status === 'idle') void load();
  }, [status, load]);

  const items = useMemo(
    () => [
      {
        value: 'queue' as const,
        label: 'Waiting on you',
        icon: Inbox,
        count: pendingCount,
      },
      {
        value: 'grants' as const,
        label: 'Grants',
        icon: KeyRound,
        count: grantCount,
      },
      { value: 'history' as const, label: 'History', icon: History },
    ],
    [pendingCount, grantCount],
  );

  const description =
    pendingCount > 0
      ? `${pluralize(pendingCount, 'action')} waiting on a decision.`
      : 'Actions waiting on you, and the standing grants you have given.';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Approvals"
        description={description}
        sticky={false}
        actions={
          <>
            {pendingCount > 0 ? (
              <Badge tone="warning" variant="soft" size="md">
                {pendingCount} waiting
              </Badge>
            ) : null}
            {/* Refresh is a real affordance here, not decoration: the queue is
                push-driven, and a push missed while the window slept is exactly
                the failure a person needs a way out of. */}
            <Button
              size="sm"
              variant="ghost"
              icon={RotateCcw}
              onClick={() => {
                void load();
                void loadGrants();
              }}
            >
              Refresh
            </Button>
          </>
        }
        toolbar={
          <Tabs
            label="Approval sections"
            items={items}
            value={tab}
            onValueChange={(next) => navigate(TAB_PATH[next])}
          />
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-5 py-5">
          {!gateOn ? (
            <NoticePanel
              tone="danger"
              icon={ShieldAlert}
              eyebrow="Gate disabled"
              title="Side-effecting tools are running without asking you"
              className="mb-4"
            >
              <span>
                “Require approval for side-effecting tools” is switched off in
                Settings → Approvals. Nothing will appear in this queue while it
                stays off, including the things that send, delete or spend.
              </span>
            </NoticePanel>
          ) : null}

          <Routes>
            <Route
              index
              element={
                <ApprovalQueue
                  now={now}
                  onOpenRun={(runId) => navigate(`${ROUTES.runs}/${runId}`)}
                  onShowGrants={() => navigate(TAB_PATH.grants)}
                />
              }
            />
            <Route path="grants" element={<GrantsPanel now={now} />} />
            <Route path="history" element={<HistoryPanel now={now} />} />
            <Route
              path="*"
              element={<Navigate to={ROUTES.approvals} replace />}
            />
          </Routes>
        </div>
      </div>
    </div>
  );
}

export default ApprovalsScreen;
