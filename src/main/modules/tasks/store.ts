/**
 * Task-card persistence.
 *
 * Every statement is a prepared statement with bound parameters. Where a query
 * is assembled (the list filters) only *structure* is concatenated — the
 * fragments are literals in this file and every value goes through a `?`.
 *
 * The store is deliberately synchronous apart from `persist()`: sql.js is
 * synchronous, and an `await` between reading a card and writing it back would
 * be an invitation to interleave.
 */
import type { Db, Row, SqlParam } from '../../infra/db';
import { randomId } from '../../infra/crypto';
import { nowIso } from '../../../shared/common';
import type { Page } from '../../../shared/common';
import { TASK_PRIORITIES } from '../../../shared/tasks';
import {
  APPROVAL_MODES,
  AcceptanceCriterionSchema,
  BOARD_KINDS,
  BoardRef,
  DestructiveOperationBlockedError,
  DestructiveOptions,
  EvidenceSchema,
  PlanStepSchema,
  TERMINAL_CARD_STATUSES,
  TaskCard,
  TaskCardCreate,
  TaskCardQuery,
  TaskCardSchema,
  TaskCardUpdate,
  resolveBoard,
  toCardStatus,
} from './schema';

/* ------------------------------------------------------------------ */
/* Row <-> card                                                        */
/* ------------------------------------------------------------------ */

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Parse a JSON column. A malformed blob yields the fallback rather than
 * throwing — one bad row must not make the whole board unreadable.
 */
function jsonColumn<T>(
  value: unknown,
  schema: { parse(v: unknown): T },
  fallback: T[],
): T[] {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fallback;
  }
  if (!Array.isArray(parsed)) return fallback;
  const out: T[] = [];
  for (const item of parsed) {
    try {
      out.push(schema.parse(item));
    } catch {
      /* drop the malformed entry, keep the rest */
    }
  }
  return out;
}

function metadataColumn(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

function enumColumn<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function stringArrayColumn(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    /* fall through */
  }
  return [];
}

/**
 * One row as a card.
 *
 * `card_status` is still the column name — there is real data in it — but it
 * holds a `TaskStatus` directly now. {@link toCardStatus} normalises rows
 * written with the superseded spellings (`inbox`, `doing`, `cancelled`).
 */
export function rowToCard(row: Row): TaskCard {
  return {
    id: text(row.id),
    board: enumColumn(row.board, BOARD_KINDS, 'personal'),
    conversationId: optionalText(row.conversation_id),
    title: text(row.title),
    description: text(row.description),
    notes: text(row.notes),
    status: toCardStatus(text(row.card_status, 'todo')),
    priority: enumColumn(row.priority, TASK_PRIORITIES, 'normal'),
    objective: text(row.objective),
    desiredOutcome: text(row.desired_outcome),
    plan: jsonColumn(row.plan, PlanStepSchema, []),
    acceptanceCriteria: jsonColumn(
      row.acceptance_criteria,
      AcceptanceCriterionSchema,
      [],
    ),
    assignedAgent: optionalText(row.assigned_agent),
    approvalMode: enumColumn(row.approval_mode, APPROVAL_MODES, 'manual'),
    blockerReason: optionalText(row.blocker_reason),
    evidence: jsonColumn(row.evidence, EvidenceSchema, []),
    goalId: optionalText(row.goal_id),
    parentId: optionalText(row.parent_id),
    dueAt: optionalText(row.due_at),
    scheduledFor: optionalText(row.scheduled_for),
    tags: stringArrayColumn(row.tags),
    source: text(row.source, 'user'),
    externalId: optionalText(row.external_id),
    order: Number(row.sort_order ?? 0),
    createdAt: text(row.created_at, nowIso()),
    updatedAt: text(row.updated_at, nowIso()),
    completedAt: optionalText(row.completed_at),
    metadata: metadataColumn(row.metadata),
  };
}

/* ------------------------------------------------------------------ */
/* Query building                                                      */
/* ------------------------------------------------------------------ */

const SELECT_COLUMNS = `
  id, board, conversation_id, title, description, notes, card_status, priority,
  objective, desired_outcome, plan, acceptance_criteria, assigned_agent,
  approval_mode, blocker_reason, evidence, goal_id, parent_id, due_at,
  scheduled_for, tags, source, external_id, sort_order, created_at, updated_at,
  completed_at, metadata
`;

interface Where {
  clause: string;
  params: SqlParam[];
}

/** Build the WHERE for a list query. Only literals are concatenated. */
function buildWhere(query: TaskCardQuery): Where {
  const parts: string[] = [];
  const params: SqlParam[] = [];

  if (query.conversationId) {
    parts.push('board = ? AND conversation_id = ?');
    params.push('conversation', query.conversationId);
  } else if (query.board === 'personal') {
    parts.push('board = ?');
    params.push('personal');
  } else if (query.board === 'conversation') {
    parts.push('board = ?');
    params.push('conversation');
  }

  if (query.status && query.status.length > 0) {
    const statuses = [...new Set(query.status.map(toCardStatus))];
    parts.push(`card_status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  } else if (!query.includeCompleted) {
    parts.push(
      `card_status NOT IN (${TERMINAL_CARD_STATUSES.map(() => '?').join(', ')})`,
    );
    params.push(...TERMINAL_CARD_STATUSES);
  }

  if (query.priority && query.priority.length > 0) {
    parts.push(`priority IN (${query.priority.map(() => '?').join(', ')})`);
    params.push(...query.priority);
  }
  if (query.goalId) {
    parts.push('goal_id = ?');
    params.push(query.goalId);
  }
  if (query.parentId) {
    parts.push('parent_id = ?');
    params.push(query.parentId);
  }
  if (query.assignedAgent) {
    parts.push('assigned_agent = ?');
    params.push(query.assignedAgent);
  }
  if (query.dueBefore) {
    parts.push('due_at IS NOT NULL AND due_at < ?');
    params.push(query.dueBefore);
  }
  if (query.tag) {
    // Tags are a JSON array of strings; the quotes make the match exact rather
    // than a prefix ("ops" must not match "opsgenie").
    parts.push('tags LIKE ?');
    params.push(`%${JSON.stringify(query.tag)}%`);
  }
  if (query.search) {
    const like = `%${query.search.toLowerCase()}%`;
    parts.push(
      '(LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(objective) LIKE ? OR LOWER(notes) LIKE ?)',
    );
    params.push(like, like, like, like);
  }

  return {
    clause: parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '',
    params,
  };
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export interface TaskStore {
  list(query: TaskCardQuery): Page<TaskCard>;
  get(id: string): TaskCard | null;
  create(input: TaskCardCreate): TaskCard;
  update(input: TaskCardUpdate): TaskCard;
  /** Single-card delete. Subtasks are orphaned, not deleted. */
  remove(id: string): boolean;
  /** Cards on a board, oldest first. Used by the markdown renderer. */
  boardCards(board: BoardRef, includeCompleted: boolean): TaskCard[];
  countOnBoard(board: BoardRef): number;

  /* -- bulk, destructive, opt-in only -- */
  clearBoard(board: BoardRef, options?: DestructiveOptions): number;
  removeMany(ids: string[], options?: DestructiveOptions): number;
  replaceBoard(
    board: BoardRef,
    cards: TaskCardCreate[],
    options?: DestructiveOptions,
  ): TaskCard[];
}

/** Fields whose emptiness means "unset the column". */
function nullable(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

export function createTaskStore(db: Db): TaskStore {
  const selectById = (id: string): Row | undefined =>
    db.get(`SELECT ${SELECT_COLUMNS} FROM tasks_card WHERE id = ?`, [id]);

  const nextOrder = (board: BoardRef): number => {
    const max = db.pluck<number>(
      "SELECT COALESCE(MAX(sort_order), -1) FROM tasks_card WHERE board = ? AND COALESCE(conversation_id, '') = ?",
      [board.board, board.conversationId ?? ''],
    );
    return Number(max ?? -1) + 1;
  };

  const insert = (input: TaskCardCreate, at: string): TaskCard => {
    const board = resolveBoard(input);
    // A writer may send a legacy spelling; normalise before it is stored.
    const status = toCardStatus(input.status);
    const id = randomId('task');
    const parsed = TaskCardSchema.parse({
      ...input,
      id,
      board: board.board,
      conversationId: board.conversationId,
      status,
      order: input.order ?? nextOrder(board),
      createdAt: at,
      updatedAt: at,
      completedAt: status === 'done' ? at : undefined,
    });

    db.run(
      `INSERT INTO tasks_card (
         id, board, conversation_id, title, description, notes, card_status,
         priority, objective, desired_outcome, plan, acceptance_criteria,
         assigned_agent, approval_mode, blocker_reason, evidence, goal_id,
         parent_id, due_at, scheduled_for, tags, source, external_id,
         sort_order, created_at, updated_at, completed_at, metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parsed.id,
        parsed.board,
        parsed.conversationId ?? null,
        parsed.title,
        parsed.description,
        parsed.notes,
        parsed.status,
        parsed.priority,
        parsed.objective,
        parsed.desiredOutcome,
        JSON.stringify(parsed.plan),
        JSON.stringify(parsed.acceptanceCriteria),
        nullable(parsed.assignedAgent),
        parsed.approvalMode,
        nullable(parsed.blockerReason),
        JSON.stringify(parsed.evidence),
        nullable(parsed.goalId),
        nullable(parsed.parentId),
        nullable(parsed.dueAt),
        nullable(parsed.scheduledFor),
        JSON.stringify(parsed.tags),
        parsed.source,
        nullable(parsed.externalId),
        parsed.order,
        parsed.createdAt,
        parsed.updatedAt,
        parsed.completedAt ?? null,
        JSON.stringify(parsed.metadata),
      ],
    );
    return parsed;
  };

  const store: TaskStore = {
    list(query) {
      const where = buildWhere(query);
      const total = Number(
        db.pluck<number>(
          `SELECT COUNT(*) FROM tasks_card ${where.clause}`,
          where.params,
        ) ?? 0,
      );
      const rows = db.all(
        `SELECT ${SELECT_COLUMNS} FROM tasks_card ${where.clause}
         ORDER BY sort_order ASC, created_at ASC LIMIT ? OFFSET ?`,
        [...where.params, query.limit, query.offset],
      );
      return {
        items: rows.map(rowToCard),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    },

    get(id) {
      const row = selectById(id);
      return row ? rowToCard(row) : null;
    },

    create(input) {
      return db.transaction(() => insert(input, nowIso()));
    },

    update(input) {
      return db.transaction(() => {
        const existing = store.get(input.id);
        if (!existing) throw new Error(`No such task: ${input.id}`);

        const at = nowIso();
        const sets: string[] = [];
        const params: SqlParam[] = [];
        const push = (column: string, value: SqlParam): void => {
          sets.push(`${column} = ?`);
          params.push(value);
        };

        if (input.title !== undefined) push('title', input.title);
        if (input.description !== undefined)
          push('description', input.description);
        if (input.notes !== undefined) push('notes', input.notes);
        if (input.priority !== undefined) push('priority', input.priority);
        if (input.objective !== undefined) push('objective', input.objective);
        if (input.desiredOutcome !== undefined) {
          push('desired_outcome', input.desiredOutcome);
        }
        if (input.plan !== undefined) push('plan', JSON.stringify(input.plan));
        if (input.acceptanceCriteria !== undefined) {
          push('acceptance_criteria', JSON.stringify(input.acceptanceCriteria));
        }
        if (input.assignedAgent !== undefined) {
          push('assigned_agent', nullable(input.assignedAgent));
        }
        if (input.approvalMode !== undefined) {
          push('approval_mode', input.approvalMode);
        }
        if (input.blockerReason !== undefined) {
          push('blocker_reason', nullable(input.blockerReason));
        }
        if (input.evidence !== undefined) {
          push('evidence', JSON.stringify(input.evidence));
        }
        if (input.goalId !== undefined) push('goal_id', nullable(input.goalId));
        if (input.parentId !== undefined) {
          if (input.parentId === input.id) {
            throw new Error('A task cannot be its own parent.');
          }
          push('parent_id', nullable(input.parentId));
        }
        if (input.dueAt !== undefined) push('due_at', nullable(input.dueAt));
        if (input.scheduledFor !== undefined) {
          push('scheduled_for', nullable(input.scheduledFor));
        }
        if (input.tags !== undefined) push('tags', JSON.stringify(input.tags));
        if (input.source !== undefined) push('source', input.source);
        if (input.externalId !== undefined) {
          push('external_id', nullable(input.externalId));
        }
        if (input.order !== undefined) push('sort_order', input.order);
        if (input.metadata !== undefined) {
          push('metadata', JSON.stringify(input.metadata));
        }

        if (input.board !== undefined || input.conversationId !== undefined) {
          const moved = resolveBoard({
            board:
              input.board ??
              (input.conversationId ? 'conversation' : undefined),
            conversationId: input.conversationId,
          });
          push('board', moved.board);
          push('conversation_id', moved.conversationId ?? null);
        }

        if (input.status !== undefined) {
          const cardStatus = toCardStatus(input.status);
          push('card_status', cardStatus);
          if (cardStatus === 'done') {
            push('completed_at', existing.completedAt ?? at);
          } else {
            push('completed_at', null);
          }
          // Leaving `blocked` clears a stale reason unless the caller set one.
          if (cardStatus !== 'blocked' && input.blockerReason === undefined) {
            push('blocker_reason', null);
          }
        }

        if (sets.length === 0) return existing;

        push('updated_at', at);
        params.push(input.id);
        db.run(`UPDATE tasks_card SET ${sets.join(', ')} WHERE id = ?`, params);

        const updated = store.get(input.id);
        if (!updated) throw new Error(`No such task: ${input.id}`);
        return updated;
      });
    },

    remove(id) {
      const { changes } = db.run('DELETE FROM tasks_card WHERE id = ?', [id]);
      return changes > 0;
    },

    boardCards(board, includeCompleted) {
      const params: SqlParam[] = [board.board, board.conversationId ?? ''];
      let clause = "WHERE board = ? AND COALESCE(conversation_id, '') = ?";
      if (!includeCompleted) {
        clause += ` AND card_status NOT IN (${TERMINAL_CARD_STATUSES.map(() => '?').join(', ')})`;
        params.push(...TERMINAL_CARD_STATUSES);
      }
      return db
        .all(
          `SELECT ${SELECT_COLUMNS} FROM tasks_card ${clause}
           ORDER BY sort_order ASC, created_at ASC`,
          params,
        )
        .map(rowToCard);
    },

    countOnBoard(board) {
      return Number(
        db.pluck<number>(
          "SELECT COUNT(*) FROM tasks_card WHERE board = ? AND COALESCE(conversation_id, '') = ?",
          [board.board, board.conversationId ?? ''],
        ) ?? 0,
      );
    },

    /* ---------------- destructive, opt-in only ---------------- */

    clearBoard(board, options) {
      const affected = store.countOnBoard(board);
      guard('clear the board', affected, options);
      const { changes } = db.run(
        "DELETE FROM tasks_card WHERE board = ? AND COALESCE(conversation_id, '') = ?",
        [board.board, board.conversationId ?? ''],
      );
      return changes;
    },

    removeMany(ids, options) {
      const unique = [...new Set(ids)].filter(Boolean);
      if (unique.length === 0) return 0;
      const placeholders = unique.map(() => '?').join(', ');
      const affected = Number(
        db.pluck<number>(
          `SELECT COUNT(*) FROM tasks_card WHERE id IN (${placeholders})`,
          unique,
        ) ?? 0,
      );
      guard('remove several tasks at once', affected, options);
      const { changes } = db.run(
        `DELETE FROM tasks_card WHERE id IN (${placeholders})`,
        unique,
      );
      return changes;
    },

    replaceBoard(board, cards, options) {
      const affected = store.countOnBoard(board);
      guard('replace the whole board', affected, options);
      return db.transaction(() => {
        db.run(
          "DELETE FROM tasks_card WHERE board = ? AND COALESCE(conversation_id, '') = ?",
          [board.board, board.conversationId ?? ''],
        );
        const at = nowIso();
        return cards.map((card, index) =>
          insert(
            {
              ...card,
              board: board.board,
              conversationId: board.conversationId,
              order: card.order ?? index,
            },
            at,
          ),
        );
      });
    },
  };

  return store;
}

/**
 * The guard every bulk destructive path runs through.
 *
 * Default-deny. A caller that has not typed `confirmDestructive: true` gets a
 * refusal naming the flag, and `expectedCount` lets a careful caller assert what
 * it thinks it is about to destroy — a board that grew since the caller last
 * looked is a board it should look at again.
 */
function guard(
  operation: string,
  affected: number,
  options: DestructiveOptions | undefined,
): void {
  if (!options?.confirmDestructive) {
    throw new DestructiveOperationBlockedError(operation, affected);
  }
  if (
    options.expectedCount !== undefined &&
    options.expectedCount !== affected
  ) {
    throw new DestructiveOperationBlockedError(
      operation,
      affected,
      `Expected ${options.expectedCount} task(s) but found ${affected}. Re-read the board and try again.`,
    );
  }
}
