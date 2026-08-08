/**
 * The run timeline — the highest-value surface in the product.
 *
 * Not a chat log. A run is a sequence of *steps*, each an engine invocation
 * with its own turns, cost, model and tool calls, and this renders that
 * structure directly: collapsible steps, ordered entries inside them, every
 * tool call inspectable down to its raw arguments and result.
 *
 * ## Virtualization
 *
 * `flattenTimeline` turns the model into one row per rendered element — a
 * closed step is one row, an open step is a header row plus one row per entry.
 * That flat list is what `useVirtualizer` walks, with `measureElement` for real
 * heights. The alternative (virtualizing a list of variable-height collapsible
 * containers, each with its own inner list) is the arrangement that measures
 * badly and janks; this one never nests a measured container inside another.
 *
 * Disclosure state — which steps are open, which tool calls are expanded —
 * lives here rather than in the rows, because a virtualized row is unmounted
 * the moment it leaves the viewport and would otherwise forget.
 *
 * ## Following a live run
 *
 * Auto-scroll happens **only when the user is already at the bottom**. Reading
 * step 3 of a run that is still writing step 9 must not yank you away; instead
 * a "jump to latest" pill appears and you decide.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDownToLine,
  ChevronsDownUp,
  ChevronsUpDown,
  Inbox,
  Radio,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { formatCount } from '../../lib/format';
import {
  Badge,
  Button,
  EmptyState,
  Switch,
  textMuted,
} from '../../components/ui';
import {
  defaultOpenKeys,
  flattenTimeline,
  type TimelineModel,
} from './timeline';
import {
  EmptyStepRow,
  EntryRow,
  QuietRow,
  StepHeaderRow,
  estimateRowSize,
} from './TimelineRows';
import { useShowCosts } from './CostMeter';
import { Notice } from './Notice';

/** Distance from the bottom, in px, still counted as "following the run". */
const FOLLOW_THRESHOLD = 64;

export interface RunTimelineProps {
  model: TimelineModel;
  /** `seq` values missing from the buffer. Non-empty means an honest warning. */
  gaps: number[];
  /** Ticking wall clock while the run is live. */
  now: number;
  live: boolean;
  /** Re-read the transcript from `seq` 0. */
  onReload: () => void;
  className?: string;
}

export function RunTimeline({
  model,
  gaps,
  now,
  live,
  onReload,
  className,
}: RunTimelineProps) {
  const showCosts = useShowCosts();

  // `null` means "the user has not touched this yet", which is different from
  // "everything is closed" — see `open` below.
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string> | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [hideChatter, setHideChatter] = useState(true);
  const [following, setFollowing] = useState(true);
  const [pendingBelow, setPendingBelow] = useState(false);

  /* --- which steps start open ------------------------------------- */

  /**
   * Derived at render time, not seeded in an effect: the running step has to be
   * open on the *first* paint. Seeding after mount means a frame of
   * everything-collapsed followed by a jump, which on a live run reads as a
   * glitch.
   */
  const open = useMemo(
    () => openKeys ?? defaultOpenKeys(model),
    [openKeys, model],
  );

  const seeded = useRef(false);
  const known = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (model.steps.length === 0) return;

    if (!seeded.current) {
      seeded.current = true;
      known.current = new Set(model.steps.map((step) => step.key));
      // Freeze the derived set so later steps finishing cannot re-close what
      // the user is reading.
      setOpenKeys(defaultOpenKeys(model));
      return;
    }

    // A step that starts while you are watching opens itself; one that appears
    // already finished does not, or a long run would unfold into a wall.
    const opening: string[] = [];
    model.steps.forEach((step) => {
      if (known.current.has(step.key)) return;
      known.current.add(step.key);
      if (step.status === 'running' || step.status === 'awaiting_approval') {
        opening.push(step.key);
      }
    });
    if (opening.length === 0) return;
    setOpenKeys((previous) => {
      const next = new Set(previous ?? []);
      opening.forEach((key) => next.add(key));
      return next;
    });
  }, [model]);

  const toggleStep = useCallback(
    (key: string) => {
      setOpenKeys((previous) => {
        const next = new Set(previous ?? open);
        if (!next.delete(key)) next.add(key);
        return next;
      });
    },
    [open],
  );

  const toggleEntry = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setOpenKeys(new Set(model.steps.map((step) => step.key)));
  }, [model.steps]);

  const collapseAll = useCallback(() => {
    setOpenKeys(new Set<string>());
  }, []);

  /* --- rows -------------------------------------------------------- */

  const rows = useMemo(
    () => flattenTimeline(model, { open, hideChatter }),
    [model, open, hideChatter],
  );

  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateRowSize(rows[index]),
    getItemKey: (index) => rows[index].key,
    overscan: 10,
    // A sensible window before the ResizeObserver reports, so the first
    // paint is real rows rather than an empty box.
    initialRect: { width: 0, height: 640 },
  });

  /* --- follow-the-tail, but only if the user is already there ------ */

  const followingRef = useRef(following);
  followingRef.current = following;

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distance =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    const atBottom = distance <= FOLLOW_THRESHOLD;
    if (atBottom !== followingRef.current) setFollowing(atBottom);
    if (atBottom) setPendingBelow(false);
  }, []);

  const jumpToLatest = useCallback(() => {
    if (rows.length === 0) return;
    setFollowing(true);
    setPendingBelow(false);
    virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
  }, [rows.length, virtualizer]);

  // Only a *new event* pulls the view down. Opening a step, expanding a tool
  // call or flipping the chatter filter changes `rows` too, and must not.
  const lastSeqSeen = useRef(model.lastSeq);
  useLayoutEffect(() => {
    if (model.lastSeq <= lastSeqSeen.current) {
      lastSeqSeen.current = model.lastSeq;
      return;
    }
    lastSeqSeen.current = model.lastSeq;
    if (rows.length === 0) return;
    if (followingRef.current) {
      virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    } else {
      setPendingBelow(true);
    }
  }, [model.lastSeq, rows.length, virtualizer]);

  // A live run opens pinned to the tail; a finished one opens at the top.
  const startedAtTail = useRef(false);
  useLayoutEffect(() => {
    if (startedAtTail.current || !live || rows.length === 0) return;
    startedAtTail.current = true;
    virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
  }, [live, rows.length, virtualizer]);

  /* --- render ------------------------------------------------------ */

  const items = virtualizer.getVirtualItems();

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="flex items-center gap-3 border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
        <span className={cn('text-[11px]', textMuted)}>
          {model.steps.length} step{model.steps.length === 1 ? '' : 's'}
          {' · '}
          {formatCount(model.entryCount)} event
          {model.entryCount === 1 ? '' : 's'}
        </span>

        {live ? (
          <Badge tone="info" variant="soft" dot>
            Live
          </Badge>
        ) : null}

        <div className="flex-1" />

        <Switch
          checked={!hideChatter}
          onChange={(value) => setHideChatter(!value)}
          label="Verbose logs"
          size="sm"
          className="text-[11px]"
        />
        <Button
          size="xs"
          variant="ghost"
          icon={ChevronsUpDown}
          onClick={expandAll}
        >
          Expand all
        </Button>
        <Button
          size="xs"
          variant="ghost"
          icon={ChevronsDownUp}
          onClick={collapseAll}
        >
          Collapse
        </Button>
      </div>

      {gaps.length > 0 ? (
        <Notice
          shape="flush"
          icon={TriangleAlert}
          title={`${gaps.length} event${gaps.length === 1 ? '' : 's'} missing from this transcript`}
          actions={
            <Button
              size="xs"
              variant="outline"
              icon={RefreshCw}
              onClick={onReload}
            >
              Reload
            </Button>
          }
        >
          The stream skipped sequence{gaps.length === 1 ? ' ' : 's '}
          {gaps.slice(0, 8).join(', ')}
          {gaps.length > 8 ? `, +${gaps.length - 8} more` : ''}. What is shown
          below is real but incomplete — the full transcript is on disk.
        </Notice>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full overflow-y-auto"
        >
          {rows.length === 0 ? (
            <EmptyState
              icon={live ? Radio : Inbox}
              title={live ? 'Waiting for the first event' : 'Nothing recorded'}
              description={
                live
                  ? 'The engine has started. Steps will appear here as they run.'
                  : 'This run produced no steps or events. The transcript on disk is the full record.'
              }
              size="sm"
            />
          ) : (
            <div
              style={{
                height: virtualizer.getTotalSize(),
                width: '100%',
                position: 'relative',
              }}
            >
              {items.map((item) => {
                const row = rows[item.index];
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${item.start}px)`,
                    }}
                  >
                    {row.type === 'step' ? (
                      <StepHeaderRow
                        step={row.step}
                        open={row.open}
                        onToggle={toggleStep}
                        now={now}
                        showCosts={showCosts}
                      />
                    ) : null}
                    {row.type === 'entry' ? (
                      <EntryRow
                        entry={row.entry}
                        last={row.last}
                        expanded={expanded.has(row.entry.id)}
                        onToggle={toggleEntry}
                        now={now}
                      />
                    ) : null}
                    {row.type === 'quiet' ? (
                      <QuietRow
                        hidden={row.hidden}
                        onShow={() => setHideChatter(false)}
                      />
                    ) : null}
                    {row.type === 'empty' ? (
                      <EmptyStepRow step={row.step} />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {pendingBelow ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <Button
              size="sm"
              variant="primary"
              icon={ArrowDownToLine}
              onClick={jumpToLatest}
              className="pointer-events-auto shadow-lg"
            >
              New events below
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default RunTimeline;
