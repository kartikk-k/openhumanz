/**
 * The chat session index.
 *
 * A tiny JSON file (`<workspace>/claude-chats/sessions.json`) that remembers the
 * chat sessions we have started and which one is current. The transcripts
 * themselves are Claude Code's own JSONL files on disk — this store only tracks
 * ids, titles and ordering so the UI has a session list without having to scan
 * and parse every transcript up front.
 *
 * Session ids are minted by us (a UUID pinned via `--session-id`) so a brand-new
 * chat has an id before the CLI has written a single line, which is what lets
 * the UI show an empty session immediately.
 */
import fsp from 'fs/promises';
import path from 'path';
import { z } from 'zod';

export const ChatSessionSchema = z.object({
  id: z.string().min(1),
  /** AI-generated or first-message-derived title; may be empty until known. */
  title: z.string().default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatSession = z.infer<typeof ChatSessionSchema>;

const ChatIndexSchema = z.object({
  version: z.literal(1).default(1),
  currentSessionId: z.string().nullable().default(null),
  sessions: z.array(ChatSessionSchema).default([]),
});
export type ChatIndex = z.infer<typeof ChatIndexSchema>;

const EMPTY: ChatIndex = { version: 1, currentSessionId: null, sessions: [] };

export interface ChatStore {
  read(): Promise<ChatIndex>;
  /** Insert or update a session, bump `updatedAt`, and make it current. */
  upsert(session: {
    id: string;
    title?: string;
    createdAt?: string;
  }): Promise<ChatIndex>;
  setCurrent(id: string | null): Promise<ChatIndex>;
  setTitle(id: string, title: string): Promise<ChatIndex>;
  remove(id: string): Promise<ChatIndex>;
}

/**
 * @param dir  the `claude-chats` directory
 * @param now  injected clock (the app forbids `Date.now()` in some contexts;
 *             tests pass a fixed stamp)
 */
export function createChatStore(
  dir: string,
  now: () => string = () => new Date().toISOString(),
): ChatStore {
  const file = path.join(dir, 'sessions.json');

  const load = async (): Promise<ChatIndex> => {
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const parsed = ChatIndexSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : { ...EMPTY };
    } catch {
      return { ...EMPTY };
    }
  };

  const save = async (index: ChatIndex): Promise<ChatIndex> => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    return index;
  };

  return {
    read: load,

    async upsert({ id, title, createdAt }) {
      const index = await load();
      const at = now();
      const existing = index.sessions.find((s) => s.id === id);
      if (existing) {
        existing.updatedAt = at;
        if (title !== undefined) existing.title = title;
      } else {
        index.sessions.unshift({
          id,
          title: title ?? '',
          createdAt: createdAt ?? at,
          updatedAt: at,
        });
      }
      index.currentSessionId = id;
      // Newest first.
      index.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return save(index);
    },

    async setCurrent(id) {
      const index = await load();
      index.currentSessionId = id;
      return save(index);
    },

    async setTitle(id, title) {
      const index = await load();
      const session = index.sessions.find((s) => s.id === id);
      if (session) {
        session.title = title;
        return save(index);
      }
      return index;
    },

    async remove(id) {
      const index = await load();
      index.sessions = index.sessions.filter((s) => s.id !== id);
      if (index.currentSessionId === id) {
        index.currentSessionId = index.sessions[0]?.id ?? null;
      }
      return save(index);
    },
  };
}
