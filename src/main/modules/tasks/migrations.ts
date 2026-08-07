/**
 * The tasks module's own schema.
 *
 * One table. `tasks_card` rather than `tasks_task` because a row is a card on a
 * board, and the module namespace prefix is required by the module contract.
 *
 * Notes on shape:
 *  - `card_status` holds the board's lifecycle; the shared `status` is derived
 *    in the mapping layer and never stored, so the two can never disagree.
 *  - `sort_order`, not `order` — `ORDER` is a reserved word.
 *  - list-valued fields (plan, criteria, tags, evidence, metadata) are JSON
 *    TEXT. They are read and written whole; nothing queries inside them.
 *  - `parent_id` is a self-referencing FK with `ON DELETE SET NULL`: deleting a
 *    parent must orphan its subtasks, never silently delete them. Foreign keys
 *    are on (`PRAGMA foreign_keys` in infra/db.ts).
 */
import type { Migration } from '../types';

export const migrations: Migration[] = [
  {
    id: '001_init',
    description: 'task cards, personal and per-conversation boards',
    up: [
      `CREATE TABLE IF NOT EXISTS tasks_card (
         id                  TEXT PRIMARY KEY,
         board               TEXT NOT NULL DEFAULT 'personal',
         conversation_id     TEXT,
         title               TEXT NOT NULL,
         description         TEXT NOT NULL DEFAULT '',
         notes               TEXT NOT NULL DEFAULT '',
         card_status         TEXT NOT NULL DEFAULT 'todo',
         priority            TEXT NOT NULL DEFAULT 'normal',
         objective           TEXT NOT NULL DEFAULT '',
         desired_outcome     TEXT NOT NULL DEFAULT '',
         plan                TEXT NOT NULL DEFAULT '[]',
         acceptance_criteria TEXT NOT NULL DEFAULT '[]',
         assigned_agent      TEXT,
         approval_mode       TEXT NOT NULL DEFAULT 'manual',
         blocker_reason      TEXT,
         evidence            TEXT NOT NULL DEFAULT '[]',
         goal_id             TEXT,
         parent_id           TEXT REFERENCES tasks_card(id) ON DELETE SET NULL,
         due_at              TEXT,
         scheduled_for       TEXT,
         tags                TEXT NOT NULL DEFAULT '[]',
         source              TEXT NOT NULL DEFAULT 'user',
         external_id         TEXT,
         sort_order          INTEGER NOT NULL DEFAULT 0,
         created_at          TEXT NOT NULL,
         updated_at          TEXT NOT NULL,
         completed_at        TEXT,
         metadata            TEXT NOT NULL DEFAULT '{}'
       );`,
      `CREATE INDEX IF NOT EXISTS tasks_card_board_idx
         ON tasks_card (board, conversation_id, card_status, sort_order);`,
      `CREATE INDEX IF NOT EXISTS tasks_card_updated_idx
         ON tasks_card (updated_at DESC);`,
      `CREATE INDEX IF NOT EXISTS tasks_card_goal_idx ON tasks_card (goal_id);`,
      `CREATE INDEX IF NOT EXISTS tasks_card_parent_idx
         ON tasks_card (parent_id);`,
    ],
  },
];

export default migrations;
