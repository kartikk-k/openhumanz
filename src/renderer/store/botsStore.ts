/**
 * Bots roster and per-bot threads.
 *
 * Threads are app-owned messages, not Claude Code sessions. Sending starts a
 * background run; switching bots never cancels anything — it just shows the
 * other thread. Live updates arrive on `push:bot-thread`.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { IPC } from '../../shared/ipc';
import { MAIN_BOT_ID } from '../../shared/bots';
import type {
  BotCreateInput,
  BotMessage,
  BotUpdateInput,
  BotWithUnread,
} from '../../shared/bots';
import { IpcError, call } from '../lib/ipc';
import { initialLoadable, type LoadableState } from './types';

/**
 * Roster row. Another agent may attach last-message fields to the IPC payload;
 * we accept them when present and otherwise derive a preview from loaded
 * messages.
 */
export type RosterBot = BotWithUnread & {
  lastMessagePreview?: string;
  lastMessageAt?: string;
};

const EMPTY_MESSAGES: BotMessage[] = [];

interface BotsState extends LoadableState {
  bots: Record<string, RosterBot>;
  order: string[];
  messagesByBot: Record<string, BotMessage[]>;
  /** Default `bot_main` once the roster has loaded. */
  selectedBotId: string | null;
  /** True only while a `bots:send` IPC is in flight — not while a run works. */
  sending: boolean;
  /** Optimistic user text, keyed by bot, until the real thread carries it. */
  pendingByBot: Record<string, string>;

  loadRoster: () => Promise<void>;
  selectBot: (id: string) => Promise<void>;
  loadMessages: (botId: string) => Promise<void>;
  send: (prompt: string) => Promise<void>;
  createBot: (input: BotCreateInput) => Promise<RosterBot | null>;
  updateBot: (input: BotUpdateInput) => Promise<RosterBot | null>;
  archiveBot: (id: string) => Promise<boolean>;
  markRead: (botId: string) => Promise<void>;
  applyThreadPush: (payload: {
    botId: string;
    rosterChanged?: boolean;
  }) => void;
}

function asRosterBot(bot: BotWithUnread): RosterBot {
  const extra = bot as RosterBot;
  return {
    ...bot,
    lastMessagePreview: extra.lastMessagePreview,
    lastMessageAt: extra.lastMessageAt,
  };
}

function pinMain(ids: string[]): string[] {
  if (!ids.includes(MAIN_BOT_ID)) return ids;
  return [MAIN_BOT_ID, ...ids.filter((id) => id !== MAIN_BOT_ID)];
}

function defaultSelectedId(order: string[]): string | null {
  if (order.includes(MAIN_BOT_ID)) return MAIN_BOT_ID;
  return order[0] ?? null;
}

function lastUserText(messages: BotMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    return message.blocks
      .filter(
        (
          block,
        ): block is Extract<
          (typeof message.blocks)[number],
          { kind: 'text' }
        > => block.kind === 'text',
      )
      .map((block) => block.text)
      .join('\n')
      .trim();
  }
  return '';
}

export const useBotsStore = create<BotsState>((set, get) => ({
  ...initialLoadable,
  bots: {},
  order: [],
  messagesByBot: {},
  selectedBotId: null,
  sending: false,
  pendingByBot: {},

  loadRoster: async () => {
    if (get().order.length === 0) set({ status: 'loading' });
    try {
      const list = await call(IPC.bots.list, {});
      const bots: Record<string, RosterBot> = { ...get().bots };
      list.forEach((bot) => {
        bots[bot.id] = { ...bots[bot.id], ...asRosterBot(bot) };
      });
      const listed = new Set(list.map((bot) => bot.id));
      Object.keys(bots).forEach((id) => {
        if (!listed.has(id)) delete bots[id];
      });
      const order = pinMain(list.map((bot) => bot.id));
      const previous = get().selectedBotId;
      const selectedBotId =
        previous && order.includes(previous)
          ? previous
          : defaultSelectedId(order);
      set({
        bots,
        order,
        selectedBotId,
        status: 'ready',
        error: null,
        unavailable: false,
        loadedAt: new Date().toISOString(),
      });
      if (selectedBotId && selectedBotId !== previous) {
        void get().selectBot(selectedBotId);
      }
    } catch (cause) {
      const error = cause as IpcError;
      set({
        status: 'error',
        error: error.message,
        unavailable: error.isUnavailable ?? false,
      });
    }
  },

  selectBot: async (id) => {
    set({ selectedBotId: id });
    await Promise.all([get().loadMessages(id), get().markRead(id)]);
  },

  loadMessages: async (botId) => {
    try {
      const result = await call(IPC.bots.messages, { botId });
      const pending = get().pendingByBot[botId];
      const settled =
        pending != null && lastUserText(result.messages) === pending;
      set((state) => {
        const pendingByBot = { ...state.pendingByBot };
        if (settled) delete pendingByBot[botId];
        return {
          messagesByBot: { ...state.messagesByBot, [botId]: result.messages },
          pendingByBot,
        };
      });
    } catch (cause) {
      const error = cause as IpcError;
      set({
        error: error.message,
        unavailable: error.isUnavailable ?? false,
      });
    }
  },

  send: async (prompt) => {
    const botId = get().selectedBotId;
    const text = prompt.trim();
    if (!botId || !text) return;
    set((state) => ({
      sending: true,
      pendingByBot: { ...state.pendingByBot, [botId]: text },
      error: null,
    }));
    try {
      await call(IPC.bots.send, {
        botId,
        prompt: text,
        source: 'chat',
        author: 'you',
      });
      await get().loadMessages(botId);
    } catch (cause) {
      const error = cause as IpcError;
      set((state) => {
        const pendingByBot = { ...state.pendingByBot };
        delete pendingByBot[botId];
        return {
          pendingByBot,
          error: error.message,
          unavailable: error.isUnavailable ?? false,
        };
      });
    } finally {
      set({ sending: false });
    }
  },

  createBot: async (input) => {
    try {
      const created = asRosterBot(await call(IPC.bots.create, input));
      set((state) => ({
        bots: { ...state.bots, [created.id]: created },
        order: pinMain(
          state.order.includes(created.id)
            ? state.order
            : [...state.order, created.id],
        ),
        error: null,
        unavailable: false,
      }));
      await get().selectBot(created.id);
      return created;
    } catch (cause) {
      const error = cause as IpcError;
      set({
        error: error.message,
        unavailable: error.isUnavailable ?? false,
      });
      return null;
    }
  },

  updateBot: async (input) => {
    try {
      const updated = asRosterBot(await call(IPC.bots.update, input));
      set((state) => ({
        bots: { ...state.bots, [updated.id]: updated },
        error: null,
        unavailable: false,
      }));
      return updated;
    } catch (cause) {
      const error = cause as IpcError;
      set({
        error: error.message,
        unavailable: error.isUnavailable ?? false,
      });
      return null;
    }
  },

  archiveBot: async (id) => {
    if (id === MAIN_BOT_ID) return false;
    try {
      await call(IPC.bots.archive, { id });
      const state = get();
      const bots = { ...state.bots };
      delete bots[id];
      const order = state.order.filter((botId) => botId !== id);
      const selectedBotId =
        state.selectedBotId === id
          ? defaultSelectedId(order)
          : state.selectedBotId;
      const messagesByBot = { ...state.messagesByBot };
      delete messagesByBot[id];
      const pendingByBot = { ...state.pendingByBot };
      delete pendingByBot[id];
      set({
        bots,
        order,
        selectedBotId,
        messagesByBot,
        pendingByBot,
        error: null,
        unavailable: false,
      });
      if (selectedBotId && selectedBotId !== state.selectedBotId) {
        void get().selectBot(selectedBotId);
      }
      return true;
    } catch (cause) {
      const error = cause as IpcError;
      set({
        error: error.message,
        unavailable: error.isUnavailable ?? false,
      });
      return false;
    }
  },

  markRead: async (botId) => {
    try {
      const result = await call(IPC.bots.markRead, { botId });
      set((state) => {
        const existing = state.bots[botId];
        if (!existing) return state;
        return {
          bots: {
            ...state.bots,
            [botId]: { ...existing, unread: result.unread },
          },
        };
      });
    } catch {
      // Mark-read is best-effort; a missing handler must not empty the roster.
    }
  },

  applyThreadPush: ({ botId, rosterChanged }) => {
    void get().loadMessages(botId);
    // A push for the open thread is not unread. Mark it on the server *before*
    // refetching the roster, or loadRoster would restore the old count.
    if (botId === get().selectedBotId) {
      void get()
        .markRead(botId)
        .then(() => {
          if (rosterChanged) void get().loadRoster();
          return undefined;
        });
      return;
    }
    if (rosterChanged) void get().loadRoster();
  },
}));

/** Roster in display order. Main is first. */
export function useBotList(): RosterBot[] {
  const bots = useBotsStore((state) => state.bots);
  const order = useBotsStore((state) => state.order);
  return useMemo(
    () =>
      order
        .map((id) => bots[id])
        .filter((bot): bot is RosterBot => Boolean(bot) && !bot.archived),
    [bots, order],
  );
}

export function useSelectedBot(): RosterBot | null {
  const selectedBotId = useBotsStore((state) => state.selectedBotId);
  const bots = useBotsStore((state) => state.bots);
  if (!selectedBotId) return null;
  return bots[selectedBotId] ?? null;
}

export function useSelectedMessages(): BotMessage[] {
  const selectedBotId = useBotsStore((state) => state.selectedBotId);
  const messagesByBot = useBotsStore((state) => state.messagesByBot);
  return useMemo(
    () =>
      selectedBotId
        ? (messagesByBot[selectedBotId] ?? EMPTY_MESSAGES)
        : EMPTY_MESSAGES,
    [selectedBotId, messagesByBot],
  );
}
