/**
 * Persistence for bots and their threads.
 *
 * Follows the schedule store's shape exactly: a fixed `Migration[]`, row<->domain
 * mappers that re-parse through the shared zod schema on the way out, a writable
 * `COLUMNS` map whose keys are the *only* strings that ever reach a SQL fragment,
 * and `SELECT` constants. No string-concatenated SQL; every value is bound.
 *
 * Two things this file is deliberate about:
 *
 *  - **The "Main" bot is seeded idempotently in a migration.** It has a fixed id
 *    (`bot_main`) so nothing re-creates it, and it is never archived by the seed.
 *  - **Unread is derived, not stored as a running counter.** Each bot carries a
 *    `last_read_at`; the unread count is a `COUNT(*)` of messages created after
 *    it. A stored counter drifts the moment two windows disagree; a timestamp
 *    plus a count cannot.
 */
import { z } from 'zod';
import type { Db, Migration, SqlParam } from '../../infra/db';
import { nowIso } from '../../../shared/common';
import { randomId } from '../../infra/crypto';
import {
  BotSchema,
  BotMessageSchema,
  MAIN_BOT_ID,
  MAIN_BOT_NAME,
  type Bot,
  type BotMessage,
  type BotMessageRole,
  type BotMessageSource,
  type BotWithUnread,
  type ChatBlock,
} from '../../../shared/bots';

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

export const migrations: Migration[] = [
  {
    id: '001_init',
    description: 'bots roster, thread messages, per-bot read cursor',
    up: [
      `CREATE TABLE IF NOT EXISTS bots (
         id             TEXT PRIMARY KEY,
         name           TEXT NOT NULL,
         avatar_color   TEXT NOT NULL DEFAULT '#6366f1',
         system_prompt  TEXT NOT NULL DEFAULT '',
         allowed_tools_json TEXT NOT NULL DEFAULT '[]',
         workspace_dir  TEXT NOT NULL DEFAULT '',
         archived       INTEGER NOT NULL DEFAULT 0,
         last_read_at   TEXT,
         created_at     TEXT NOT NULL,
         updated_at     TEXT NOT NULL,
         metadata_json  TEXT NOT NULL DEFAULT '{}'
       );`,
      `CREATE INDEX IF NOT EXISTS bots_archived
         ON bots (archived, created_at);`,
      `CREATE TABLE IF NOT EXISTS bot_messages (
         id          TEXT PRIMARY KEY,
         bot_id      TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
         role        TEXT NOT NULL,
         author      TEXT NOT NULL DEFAULT '',
         blocks_json TEXT NOT NULL DEFAULT '[]',
         run_id      TEXT,
         source      TEXT NOT NULL DEFAULT 'chat',
         created_at  TEXT NOT NULL
       );`,
      `CREATE INDEX IF NOT EXISTS bot_messages_thread
         ON bot_messages (bot_id, created_at);`,
      `CREATE INDEX IF NOT EXISTS bot_messages_run
         ON bot_messages (run_id);`,
    ],
  },
  {
    id: '002_seed_main',
    description: 'seed the non-deletable "Main" bot',
    // A data migration so the seed runs once and is recorded in `_migrations`.
    // `INSERT OR IGNORE` keyed on the fixed id makes it idempotent even if the
    // row already exists from a hand-run or a prior build.
    up: (db: Db) => {
      const now = nowIso();
      db.run(
        `INSERT OR IGNORE INTO bots
           (id, name, avatar_color, system_prompt, allowed_tools_json,
            workspace_dir, archived, last_read_at, created_at, updated_at,
            metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, '{}')`,
        [MAIN_BOT_ID, MAIN_BOT_NAME, '#6366f1', '', '[]', '', now, now],
      );
    },
  },
  {
    id: '003_session',
    description:
      'per-bot engine session id, so a bot thread has memory across turns',
    up: [
      // Each bot turn is a separate run; storing the engine session id lets the
      // next run resume it, giving the thread continuity. Null = no session yet.
      `ALTER TABLE bots ADD COLUMN session_id TEXT;`,
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Row <-> domain                                                      */
/* ------------------------------------------------------------------ */

interface BotRow {
  id: string;
  name: string;
  avatar_color: string;
  system_prompt: string;
  allowed_tools_json: string;
  workspace_dir: string;
  archived: number;
  last_read_at: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

interface BotMessageDbRow {
  id: string;
  bot_id: string;
  role: string;
  author: string;
  blocks_json: string;
  run_id: string | null;
  source: string;
  created_at: string;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** A stored row as a {@link Bot}, re-parsed through the shared schema. */
export function rowToBot(row: BotRow): Bot {
  return BotSchema.parse({
    id: row.id,
    name: row.name,
    avatarColor: row.avatar_color || '#6366f1',
    systemPrompt: row.system_prompt ?? '',
    allowedTools: parseJson<string[]>(row.allowed_tools_json, []),
    workspaceDir: row.workspace_dir ?? '',
    archived: row.archived !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
  });
}

const PREVIEW_MAX = 80;

/** First text block, trimmed/sliced. No text → a short "Activity" fallback. */
function previewFromBlocks(blocks: ChatBlock[]): string {
  const text = blocks.find(
    (block): block is Extract<ChatBlock, { kind: 'text' }> =>
      block.kind === 'text',
  );
  const flat = text?.text.replace(/\s+/g, ' ').trim() ?? '';
  if (!flat) return 'Activity';
  return flat.length <= PREVIEW_MAX
    ? flat
    : `${flat.slice(0, PREVIEW_MAX - 1)}…`;
}

/** A stored message row as a {@link BotMessage}. Blocks are cast after validation. */
export function rowToMessage(row: BotMessageDbRow): BotMessage {
  const parsed = BotMessageSchema.parse({
    id: row.id,
    botId: row.bot_id,
    role: row.role,
    author: row.author ?? '',
    blocks: parseJson<unknown[]>(row.blocks_json, []),
    runId: row.run_id ?? undefined,
    source: row.source ?? 'chat',
    createdAt: row.created_at,
  });
  // `blocks` is validated as `unknown[]` by the shared schema (which does not
  // import the transcript parser); the render model is `ChatBlock[]`.
  return { ...parsed, blocks: parsed.blocks as ChatBlock[] };
}

/* ------------------------------------------------------------------ */
/* Writable columns                                                    */
/* ------------------------------------------------------------------ */

/**
 * Every bot column a caller may set, and how to encode it. The keys here are the
 * *only* strings that ever reach a SQL fragment; values are always bound.
 */
const BOT_COLUMNS = {
  name: (v: unknown) => String(v),
  avatar_color: (v: unknown) => String(v ?? '#6366f1'),
  system_prompt: (v: unknown) => String(v ?? ''),
  allowed_tools_json: (v: unknown) => JSON.stringify(v ?? []),
  workspace_dir: (v: unknown) => String(v ?? ''),
  archived: (v: unknown) => (v ? 1 : 0),
  last_read_at: (v: unknown) =>
    v === undefined || v === null ? null : String(v),
  session_id: (v: unknown) =>
    v === undefined || v === null ? null : String(v),
  created_at: (v: unknown) => String(v),
  updated_at: (v: unknown) => String(v),
  metadata_json: (v: unknown) => JSON.stringify(v ?? {}),
} as const;

type BotColumn = keyof typeof BOT_COLUMNS;

export type BotPatch = Partial<Record<BotColumn, unknown>>;

const SELECT_BOT = `SELECT id, name, avatar_color, system_prompt,
    allowed_tools_json, workspace_dir, archived, last_read_at, session_id,
    created_at, updated_at, metadata_json
  FROM bots`;

const SELECT_MESSAGE = `SELECT id, bot_id, role, author, blocks_json, run_id,
    source, created_at
  FROM bot_messages`;

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

/** A message to append. Id and timestamp are minted by the store. */
export interface AppendMessageInput {
  botId: string;
  role: BotMessageRole;
  author?: string;
  blocks?: ChatBlock[];
  runId?: string;
  source?: BotMessageSource;
}

/** Options for listing a thread. */
export interface ListMessagesOptions {
  limit?: number;
  offset?: number;
}

export interface BotStore {
  /** The roster. Archived bots are excluded unless asked for. */
  listBots(includeArchived?: boolean): BotWithUnread[];
  getBot(id: string): Bot | undefined;
  createBot(patch: BotPatch & { id?: string }): Bot;
  updateBot(id: string, patch: BotPatch): Bot | undefined;
  /** Soft-delete: mark archived. Returns false for the non-existent bot. */
  archiveBot(id: string): boolean;

  appendMessage(msg: AppendMessageInput): BotMessage;
  /** Replace a message's blocks (and optionally its run id) as a run streams. */
  updateMessageBlocks(
    id: string,
    blocks: ChatBlock[],
    runId?: string,
  ): BotMessage | undefined;
  getMessage(id: string): BotMessage | undefined;
  /** The message backing a run, for closing the loop on a run's transcript. */
  findMessageByRunId(runId: string): BotMessage | undefined;
  /** Every message that is (or was) backed by a run — used to recover folds. */
  listMessagesWithRuns(): BotMessage[];
  listMessages(botId: string, opts?: ListMessagesOptions): BotMessage[];

  markRead(botId: string, atIso: string): void;
  unreadCount(botId: string): number;

  /** The engine session id this bot's thread continues, or undefined if none. */
  getSessionId(botId: string): string | undefined;
  /** Persist the engine session id so the next turn resumes the conversation. */
  setSessionId(botId: string, sessionId: string): void;
}

export function createBotStore(db: Db): BotStore {
  const selectAll = `${SELECT_BOT} ORDER BY created_at, id`;
  const selectOne = `${SELECT_BOT} WHERE id = ?`;

  const encodeBot = (
    patch: BotPatch,
  ): { columns: BotColumn[]; values: SqlParam[] } => {
    const columns: BotColumn[] = [];
    const values: SqlParam[] = [];
    for (const key of Object.keys(patch) as BotColumn[]) {
      const encoder = BOT_COLUMNS[key];
      if (!encoder) continue; // never trust a key we did not define
      columns.push(key);
      values.push(encoder(patch[key]) as SqlParam);
    }
    return { columns, values };
  };

  const latestMessage = (botId: string): BotMessage | undefined => {
    const row = db.get<BotMessageDbRow & Record<string, never>>(
      `${SELECT_MESSAGE} WHERE bot_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [botId],
    );
    return row ? rowToMessage(row) : undefined;
  };

  /** Messages created strictly after `sinceIso` (the read cursor). */
  const countUnread = (botId: string, sinceIso: string | null): number => {
    // Only messages the user has not authored count as unread; a user's own
    // message is never "unread to" them.
    if (sinceIso) {
      const value = db.pluck<number>(
        `SELECT COUNT(*) FROM bot_messages
           WHERE bot_id = ? AND role != 'user' AND created_at > ?`,
        [botId, sinceIso],
      );
      return Number(value ?? 0);
    }
    const value = db.pluck<number>(
      `SELECT COUNT(*) FROM bot_messages WHERE bot_id = ? AND role != 'user'`,
      [botId],
    );
    return Number(value ?? 0);
  };

  const store: BotStore = {
    listBots(includeArchived = false) {
      const sql = includeArchived
        ? selectAll
        : `${SELECT_BOT} WHERE archived = 0 ORDER BY created_at, id`;
      return db.all<BotRow & Record<string, never>>(sql).map((row) => {
        const bot = rowToBot(row);
        const last = latestMessage(bot.id);
        return {
          ...bot,
          lastReadAt: row.last_read_at ?? null,
          unread: countUnread(bot.id, row.last_read_at ?? null),
          lastMessagePreview: last ? previewFromBlocks(last.blocks) : null,
          lastMessageAt: last?.createdAt ?? null,
        };
      });
    },

    getBot(id) {
      const row = db.get<BotRow & Record<string, never>>(selectOne, [id]);
      return row ? rowToBot(row) : undefined;
    },

    createBot(patch) {
      const id = patch.id ?? randomId('bot');
      const now = nowIso();
      const withDefaults: BotPatch = {
        created_at: now,
        updated_at: now,
        ...patch,
      };
      const { columns, values } = encodeBot(withDefaults);
      const allColumns = ['id', ...columns];
      const sql = `INSERT INTO bots (${allColumns.join(', ')}) VALUES (${allColumns
        .map(() => '?')
        .join(', ')})`;
      db.run(sql, [id, ...values]);
      const created = store.getBot(id);
      if (!created) throw new Error(`Failed to insert bot "${id}"`);
      return created;
    },

    updateBot(id, patch) {
      // `updated_at` moves on every write unless the caller pinned it.
      const withStamp: BotPatch = { updated_at: nowIso(), ...patch };
      const { columns, values } = encodeBot(withStamp);
      if (columns.length > 0) {
        const sql = `UPDATE bots SET ${columns
          .map((column) => `${column} = ?`)
          .join(', ')} WHERE id = ?`;
        db.run(sql, [...values, id]);
      }
      return store.getBot(id);
    },

    archiveBot(id) {
      const { changes } = db.run(
        'UPDATE bots SET archived = 1, updated_at = ? WHERE id = ?',
        [nowIso(), id],
      );
      return changes > 0;
    },

    appendMessage(msg) {
      const id = randomId('botmsg');
      const createdAt = nowIso();
      db.run(
        `INSERT INTO bot_messages
           (id, bot_id, role, author, blocks_json, run_id, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          msg.botId,
          msg.role,
          msg.author ?? '',
          JSON.stringify(msg.blocks ?? []),
          msg.runId ?? null,
          msg.source ?? 'chat',
          createdAt,
        ],
      );
      const created = store.getMessage(id);
      if (!created) throw new Error(`Failed to insert bot message "${id}"`);
      return created;
    },

    updateMessageBlocks(id, blocks, runId) {
      if (runId !== undefined) {
        db.run(
          'UPDATE bot_messages SET blocks_json = ?, run_id = ? WHERE id = ?',
          [JSON.stringify(blocks), runId, id],
        );
      } else {
        db.run('UPDATE bot_messages SET blocks_json = ? WHERE id = ?', [
          JSON.stringify(blocks),
          id,
        ]);
      }
      return store.getMessage(id);
    },

    getMessage(id) {
      const row = db.get<BotMessageDbRow & Record<string, never>>(
        `${SELECT_MESSAGE} WHERE id = ?`,
        [id],
      );
      return row ? rowToMessage(row) : undefined;
    },

    findMessageByRunId(runId) {
      const row = db.get<BotMessageDbRow & Record<string, never>>(
        `${SELECT_MESSAGE} WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`,
        [runId],
      );
      return row ? rowToMessage(row) : undefined;
    },

    listMessagesWithRuns() {
      return db
        .all<BotMessageDbRow & Record<string, never>>(
          `${SELECT_MESSAGE} WHERE run_id IS NOT NULL AND run_id != ''
             ORDER BY created_at ASC, rowid ASC`,
        )
        .map(rowToMessage);
    },

    listMessages(botId, opts = {}) {
      const { limit = 200, offset = 0 } = opts;
      const rows = db.all<BotMessageDbRow & Record<string, never>>(
        `${SELECT_MESSAGE} WHERE bot_id = ?
           ORDER BY created_at ASC, rowid ASC LIMIT ? OFFSET ?`,
        [botId, limit, offset],
      );
      return rows.map(rowToMessage);
    },

    markRead(botId, atIso) {
      db.run('UPDATE bots SET last_read_at = ? WHERE id = ?', [atIso, botId]);
    },

    unreadCount(botId) {
      const cursor = db.pluck<string>(
        'SELECT last_read_at FROM bots WHERE id = ?',
        [botId],
      );
      return countUnread(botId, cursor ?? null);
    },

    getSessionId(botId) {
      return (
        db.pluck<string>('SELECT session_id FROM bots WHERE id = ?', [botId]) ??
        undefined
      );
    },

    setSessionId(botId, sessionId) {
      db.run('UPDATE bots SET session_id = ? WHERE id = ?', [sessionId, botId]);
    },
  };

  return store;
}

/** Schema for the metadata blob, kept permissive on purpose. */
export const MetadataSchema = z.record(z.string(), z.unknown());
