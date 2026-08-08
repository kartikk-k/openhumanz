/**
 * `/tasks` and everything under it.
 *
 * Three things live here, in one screen:
 *
 *   boards rail │ board, grouped by status │ the selected card
 *
 * plus a second view for goals. Boards are two kinds. The **personal** board is
 * the standing one and outlives every conversation; a **conversation** board is
 * scoped to one run and is what an agent uses for the plan it is executing
 * right now. They are listed together in the rail because switching between
 * "what I am doing" and "what it is doing" is the thing this screen is for.
 *
 * Routing is nested here rather than in `App.tsx`, which routes `/tasks/*` as a
 * splat: `/tasks` is the board, `/tasks/goals` the goals, `/tasks/card/:id` the
 * board with a card open. The card is a real place, so Back closes it.
 *
 * `push:tasks-changed` and `push:goals-changed` are wired by the queries on this
 * screen — they are this feature's own channels, not bootstrap's.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';
import {
  ListTodo,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Target,
  User,
} from 'lucide-react';
import { IPC, IPC_PUSH } from '../../../shared/ipc';
import {
  TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  type Task,
  type TaskStatus,
} from '../../../shared/tasks';
import { ROUTES } from '../../routes';
import { cn } from '../../lib/utils';
import { useMutation, useQuery } from '../../lib/ipc';
import { formatRelative, pluralize } from '../../lib/format';
import { toast } from '../../store/toastStore';
import { PageHeader } from '../../components/layout/PageHeader';
import {
  Button,
  EmptyState,
  Input,
  Select,
  Spinner,
  Switch,
  Tabs,
  type TabItem,
} from '../../components/ui';
import { eyebrow, focusRing, textMuted } from '../../components/ui/styles';
import { Board } from './Board';
import { GoalsPanel } from './GoalsPanel';
import { TaskDetail, type TaskPatch } from './TaskDetail';
import { TaskDialog } from './TaskDialog';
import { BridgeNotice, boardsFrom, type BoardRef } from './parts';

/** Cards fetched for the visible board. The channel caps at 500. */
const BOARD_LIMIT = 200;
/** Cards fetched to build the board rail. Counts only, never rendered as cards. */
const INDEX_LIMIT = 500;
/** Typing pause before a search crosses the IPC boundary. */
const SEARCH_DEBOUNCE_MS = 220;

/** Columns shown when completed cards are hidden. */
const OPEN_STATUSES = TASK_STATUSES.filter(
  (status) => !TERMINAL_TASK_STATUSES.includes(status),
);

type View = 'board' | 'goals';

export function TasksScreen() {
  const navigate = useNavigate();
  const goalsMatch = useMatch(`${ROUTES.tasks}/goals`);
  const cardMatch = useMatch(`${ROUTES.tasks}/card/:taskId`);
  const view: View = goalsMatch ? 'goals' : 'board';
  const selectedId = cardMatch?.params.taskId ?? null;

  const [boardKey, setBoardKey] = useState<string>('personal');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [agent, setAgent] = useState<string>('');
  const [showCompleted, setShowCompleted] = useState(false);
  const [composerStatus, setComposerStatus] = useState<TaskStatus | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedSearch(search.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [search]);

  /* --- data ------------------------------------------------------- */

  // Every board, for the rail. Counts and names only.
  const index = useQuery(
    IPC.tasks.list,
    { includeCompleted: true, limit: INDEX_LIMIT },
    { refetchOn: [IPC_PUSH.tasksChanged] },
  );

  const boards = useMemo(
    () => boardsFrom(index.data?.items ?? []),
    [index.data],
  );

  const activeBoard: BoardRef = boards.find(
    (entry) => entry.key === boardKey,
  ) ??
    boards[0] ?? {
      key: 'personal',
      label: 'Personal',
      board: 'personal',
      count: 0,
      touchedAt: '',
    };

  // The visible board. Filtered by the channel, not in the renderer, because
  // `TaskQuery` is where board scoping belongs.
  const cards = useQuery(
    IPC.tasks.list,
    {
      board: activeBoard.board,
      conversationId: activeBoard.conversationId,
      assignedAgent: agent || undefined,
      search: debouncedSearch || undefined,
      includeCompleted: showCompleted,
      limit: BOARD_LIMIT,
    },
    { refetchOn: [IPC_PUSH.tasksChanged] },
  );

  const update = useMutation(IPC.tasks.update);
  const remove = useMutation(IPC.tasks.remove);

  const tasks = useMemo(() => cards.data?.items ?? [], [cards.data]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return (
      tasks.find((task) => task.id === selectedId) ??
      (index.data?.items ?? []).find((task) => task.id === selectedId) ??
      null
    );
  }, [selectedId, tasks, index.data]);

  // Only needed when the card is not in either list — a deep link, or a card
  // filtered out by the current search.
  const detail = useQuery(
    IPC.tasks.get,
    { id: selectedId ?? '' },
    {
      enabled: Boolean(selectedId) && selected === null,
      refetchOn: [IPC_PUSH.tasksChanged],
    },
  );
  const openCard = selected ?? detail.data ?? null;

  const agents = useMemo(() => {
    const found = new Set<string>();
    for (const task of index.data?.items ?? []) {
      if (task.assignedAgent) found.add(task.assignedAgent);
    }
    return [...found].sort();
  }, [index.data]);

  /* --- writes ------------------------------------------------------ */

  const patchTask = useCallback(
    async (task: Task, patch: TaskPatch) => {
      setSavingId(task.id);
      // Optimistic in both lists so the board and the rail agree instantly.
      const apply = (list: Task[]) =>
        list.map((entry) =>
          entry.id === task.id ? ({ ...entry, ...patch } as Task) : entry,
        );
      cards.setData((previous) =>
        previous
          ? { ...previous, items: apply(previous.items) }
          : (previous ?? {
              items: [],
              total: 0,
              limit: BOARD_LIMIT,
              offset: 0,
            }),
      );

      const saved = await update.mutate({ id: task.id, ...patch });
      setSavingId(null);

      if (!saved) {
        toast.error(`Could not save “${task.title}”`, {
          description: update.error?.isUnavailable
            ? 'Not connected to the backend. The change was not written.'
            : update.error?.message,
          key: `task-save-${task.id}`,
        });
      }
      void cards.refetch();
      void index.refetch();
    },
    [cards, index, update],
  );

  const deleteTask = useCallback(
    async (task: Task) => {
      const deleted = await remove.mutate({ id: task.id });
      if (!deleted) {
        toast.error(`Could not delete “${task.title}”`, {
          description: remove.error?.isUnavailable
            ? 'Not connected to the backend. The card is untouched.'
            : remove.error?.message,
        });
        return;
      }
      toast.success(`Deleted “${task.title}”`);
      navigate(ROUTES.tasks);
      void cards.refetch();
      void index.refetch();
    },
    [remove, navigate, cards, index],
  );

  /* --- header ------------------------------------------------------ */

  const statuses = showCompleted ? TASK_STATUSES : OPEN_STATUSES;
  const openCount = tasks.filter(
    (task) => !TERMINAL_TASK_STATUSES.includes(task.status),
  ).length;
  const waiting = tasks.filter(
    (task) => task.status === 'awaiting_approval',
  ).length;

  const description = (() => {
    if (view === 'goals') return 'Up to eight, in your own words, in GOALS.md.';
    if (cards.error || tasks.length === 0) {
      return 'Work in flight, and the goals it belongs to.';
    }
    const parts = [
      `${activeBoard.label}: ${pluralize(openCount, 'card')} open`,
    ];
    if (waiting > 0) parts.push(`${waiting} waiting on you`);
    return parts.join(' · ');
  })();

  const tabs: readonly TabItem<View>[] = [
    { value: 'board', label: 'Board' },
    { value: 'goals', label: 'Goals' },
  ];

  const newCard = (status: TaskStatus) => setComposerStatus(status);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Tasks"
        description={description}
        sticky={false}
        actions={
          view === 'board' ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                icon={RefreshCw}
                loading={cards.fetching && !cards.loading}
                onClick={() => {
                  void cards.refetch();
                  void index.refetch();
                }}
              >
                Refresh
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={Plus}
                onClick={() => newCard('todo')}
              >
                New card
              </Button>
            </>
          ) : null
        }
        toolbar={
          <div className="flex items-center gap-3">
            <Tabs
              items={tabs}
              value={view}
              onValueChange={(next) =>
                navigate(
                  next === 'goals' ? `${ROUTES.tasks}/goals` : ROUTES.tasks,
                )
              }
              variant="pill"
              label="Tasks sections"
            />
            {view === 'board' ? (
              <>
                <div className="flex-1" />
                <Switch
                  size="sm"
                  checked={showCompleted}
                  onChange={setShowCompleted}
                  label="Show finished"
                  layout="row"
                  className="shrink-0 gap-2"
                />
                {agents.length > 0 ? (
                  <Select
                    size="sm"
                    value={agent}
                    aria-label="Filter by assigned agent"
                    containerClassName="w-32 shrink-0"
                    options={[
                      { value: '', label: 'Anyone' },
                      ...agents.map((name) => ({ value: name, label: name })),
                    ]}
                    onChange={(event) => setAgent(event.target.value)}
                  />
                ) : null}
                <Input
                  size="sm"
                  icon={Search}
                  value={search}
                  placeholder="Search titles, objectives, notes"
                  aria-label="Search cards"
                  containerClassName="w-60"
                  onChange={(event) => setSearch(event.target.value)}
                />
              </>
            ) : null}
          </div>
        }
      />

      {view === 'goals' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <GoalsPanel />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <BoardRail
            boards={boards}
            activeKey={activeBoard.key}
            onSelect={(key) => {
              setBoardKey(key);
              navigate(ROUTES.tasks);
            }}
            className="w-[13rem] shrink-0"
          />

          <div className="flex min-w-0 flex-1 flex-col">
            {cards.error ? (
              <div className="p-5">
                <BridgeNotice
                  error={cards.error}
                  subject="the task board"
                  actions={
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        icon={RefreshCw}
                        onClick={() => {
                          void cards.refetch();
                        }}
                      >
                        Try again
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={Target}
                        onClick={() => navigate(`${ROUTES.tasks}/goals`)}
                      >
                        Go to goals
                      </Button>
                    </>
                  }
                />
              </div>
            ) : null}

            {!cards.error && cards.loading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-zinc-500">
                <Spinner size="sm" label={null} />
                Loading cards…
              </div>
            ) : null}

            {!cards.error && !cards.loading && tasks.length === 0 ? (
              <EmptyState
                icon={ListTodo}
                title={
                  debouncedSearch || agent
                    ? 'No cards match'
                    : `Nothing on the ${activeBoard.label} board`
                }
                description={
                  debouncedSearch || agent
                    ? 'Clear the search or the agent filter to see the rest of the board.'
                    : 'A card carries an objective, an ordered plan and the criteria that decide when it is done. You can write one, and so can the assistant — anything it plans for a run shows up on that run’s own board.'
                }
                action={
                  debouncedSearch || agent ? (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSearch('');
                        setAgent('');
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      icon={Plus}
                      onClick={() => newCard('todo')}
                    >
                      Write the first card
                    </Button>
                  )
                }
              />
            ) : null}

            {tasks.length > 0 ? (
              <Board
                tasks={tasks}
                statuses={statuses}
                selectedId={selectedId}
                onSelect={(task) =>
                  navigate(
                    selectedId === task.id
                      ? ROUTES.tasks
                      : `${ROUTES.tasks}/card/${task.id}`,
                  )
                }
                onStatusChange={(task, status) => {
                  void patchTask(task, { status });
                }}
                onCreate={newCard}
                className="min-h-0 flex-1"
              />
            ) : null}
          </div>

          {openCard ? (
            <TaskDetail
              task={openCard}
              saving={savingId === openCard.id}
              onSave={(patch) => {
                void patchTask(openCard, patch);
              }}
              onClose={() => navigate(ROUTES.tasks)}
              onDelete={() => {
                void deleteTask(openCard);
              }}
              className="w-[25rem] shrink-0"
            />
          ) : null}
        </div>
      )}

      <TaskDialog
        open={composerStatus !== null}
        board={activeBoard.board}
        conversationId={activeBoard.conversationId}
        status={composerStatus ?? 'todo'}
        onClose={() => setComposerStatus(null)}
        onCreated={(task) => {
          setComposerStatus(null);
          toast.success(`Created “${task.title}”`);
          void cards.refetch();
          void index.refetch();
          navigate(`${ROUTES.tasks}/card/${task.id}`);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Board rail                                                          */
/* ------------------------------------------------------------------ */

function BoardRail({
  boards,
  activeKey,
  onSelect,
  className,
}: {
  boards: readonly BoardRef[];
  activeKey: string;
  onSelect: (key: string) => void;
  className?: string;
}) {
  const conversations = boards.filter(
    (board) => board.board === 'conversation',
  );
  const personal = boards.find((board) => board.board === 'personal');

  return (
    <nav
      className={cn(
        'flex min-h-0 flex-col overflow-y-auto border-r border-zinc-200 bg-zinc-50/60 px-2 py-3 dark:border-zinc-800 dark:bg-zinc-900/40',
        className,
      )}
      aria-label="Boards"
    >
      <p className={cn('px-1.5 pb-1', eyebrow)}>Boards</p>
      {personal ? (
        <BoardButton
          board={personal}
          active={activeKey === personal.key}
          icon={User}
          onSelect={() => onSelect(personal.key)}
        />
      ) : null}

      <p className={cn('mt-3 px-1.5 pb-1', eyebrow)}>Conversations</p>
      {conversations.length === 0 ? (
        <p className={cn('px-1.5 py-1 text-[11px] leading-relaxed', textMuted)}>
          A run that plans its work gets a board here, scoped to that
          conversation.
        </p>
      ) : (
        conversations.map((board) => (
          <BoardButton
            key={board.key}
            board={board}
            active={activeKey === board.key}
            icon={MessageSquare}
            onSelect={() => onSelect(board.key)}
          />
        ))
      )}
    </nav>
  );
}

function BoardButton({
  board,
  active,
  icon: Icon,
  onSelect,
}: {
  board: BoardRef;
  active: boolean;
  icon: typeof User;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors',
        focusRing,
        active
          ? 'bg-white shadow-sm dark:bg-zinc-800'
          : 'hover:bg-white/70 dark:hover:bg-zinc-800/50',
      )}
    >
      <Icon
        size={13}
        aria-hidden="true"
        className={cn(
          'shrink-0',
          active
            ? 'text-indigo-600 dark:text-indigo-400'
            : 'text-zinc-400 dark:text-zinc-500',
        )}
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-[12.5px]',
            active
              ? 'font-medium text-zinc-900 dark:text-zinc-100'
              : 'text-zinc-600 dark:text-zinc-400',
          )}
        >
          {board.label}
        </span>
        {board.touchedAt ? (
          <span className={cn('block truncate text-[10.5px]', textMuted)}>
            {formatRelative(board.touchedAt)}
          </span>
        ) : null}
      </span>
      <span className={cn('shrink-0 text-[11px] tabular-nums', textMuted)}>
        {board.count}
      </span>
    </button>
  );
}

export default TasksScreen;
