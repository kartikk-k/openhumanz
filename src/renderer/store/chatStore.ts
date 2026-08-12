/**
 * Chat state.
 *
 * The renderer holds almost nothing: the source of truth is the Claude Code
 * session transcript on disk, which main reads and folds for us. This store
 * just tracks which session is on screen, caches the folded transcript, and
 * re-reads it whenever main pushes a `chat:updated`.
 */
import { create } from 'zustand';
import { IPC } from '../../shared/ipc';
import type {
  ChatSessionSummary,
  ChatStreamEvent,
  ChatTranscript,
} from '../../shared/ipc';
import { call, callReply } from '../lib/ipc';
import {
  emptyLiveTurn,
  reduceLiveTurn,
  type LiveTurn,
} from '../features/chat/liveTurn';

interface ChatSlice {
  sessions: ChatSessionSummary[];
  currentSessionId: string | null;
  transcript: ChatTranscript | null;
  /** True while a turn is streaming for the current session. */
  busy: boolean;
  /**
   * The message the user just sent, shown immediately so the UI never waits on
   * the transcript file to be written. Cleared once the real transcript comes
   * back carrying it (or on failure).
   */
  pendingUserMessage: string | null;
  /**
   * The assistant's reply as it streams in, folded from live engine events.
   * Rendered with the same block components as saved history, then discarded
   * once the durable transcript for the turn is on disk.
   */
  liveTurn: LiveTurn | null;
  loading: boolean;
  error: string | null;

  /** Load the session list and the current transcript. */
  init: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  /** Re-read the current (or given) session's transcript. */
  loadTranscript: (sessionId?: string | null) => Promise<void>;
  send: (prompt: string, surface?: 'home' | 'chat') => Promise<void>;
  newChat: () => Promise<void>;
  /** Cancel the in-flight turn (Esc). */
  cancel: () => Promise<void>;
  selectSession: (sessionId: string) => Promise<void>;
  /** Apply a `push:chat-updated` payload. */
  applyUpdate: (payload: {
    sessionId: string | null;
    busy: boolean;
    sessionsChanged?: boolean;
  }) => void;
  /** Apply a `push:chat-stream` live event. */
  applyStreamEvent: (payload: {
    sessionId: string | null;
    event: ChatStreamEvent;
  }) => void;
}

export const useChatStore = create<ChatSlice>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  transcript: null,
  busy: false,
  pendingUserMessage: null,
  liveTurn: null,
  loading: false,
  error: null,

  init: async () => {
    set({ loading: true, error: null });
    try {
      const list = await call(IPC.chat.sessions, {});
      set({
        sessions: list.sessions,
        currentSessionId: list.currentSessionId,
      });
      await get().loadTranscript(list.currentSessionId);
    } catch (cause) {
      set({ error: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      set({ loading: false });
    }
  },

  refreshSessions: async () => {
    const reply = await callReply(IPC.chat.sessions, {});
    if (reply.ok) {
      set({
        sessions: reply.data.sessions,
        currentSessionId: reply.data.currentSessionId,
      });
    }
  },

  loadTranscript: async (sessionId) => {
    const id = sessionId ?? get().currentSessionId ?? undefined;
    const reply = await callReply(IPC.chat.transcript, { sessionId: id });
    if (reply.ok) {
      // Once the real transcript carries the pending message as its last user
      // turn, drop the optimistic copy so we don't show it twice.
      const pending = get().pendingUserMessage;
      const lastUser = [...reply.data.turns]
        .reverse()
        .find((turn) => turn.message.role === 'user');
      const lastUserText = lastUser?.message.blocks
        .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      const settled = pending != null && lastUserText === pending;
      set({
        transcript: reply.data,
        currentSessionId: reply.data.sessionId,
        busy: reply.data.busy,
        pendingUserMessage: settled ? null : pending,
      });
    }
  },

  send: async (prompt, surface = 'chat') => {
    const text = prompt.trim();
    if (!text) return;
    // Optimistic: show the user's message, open a fresh live turn, and lock the
    // composer immediately, so the UI never waits on the transcript file.
    set({ busy: true, pendingUserMessage: text, liveTurn: emptyLiveTurn() });
    try {
      const ack = await call(IPC.chat.send, { prompt: text, surface });
      set({ currentSessionId: ack.sessionId });
    } catch (cause) {
      set({
        busy: false,
        pendingUserMessage: null,
        liveTurn: null,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  },

  newChat: async () => {
    const ref = await call(IPC.chat.newSession, {});
    set({
      currentSessionId: ref.currentSessionId,
      transcript: {
        sessionId: null,
        title: null,
        turns: [],
        busy: false,
      },
      busy: false,
      pendingUserMessage: null,
      liveTurn: null,
    });
    await get().refreshSessions();
  },

  cancel: async () => {
    if (!get().busy) return;
    // optimistic: unlock the UI immediately; main aborts the turn.
    set({ busy: false, liveTurn: null });
    await callReply(IPC.chat.cancel, {});
  },

  selectSession: async (sessionId) => {
    await call(IPC.chat.selectSession, { sessionId });
    set({
      currentSessionId: sessionId,
      pendingUserMessage: null,
      liveTurn: null,
    });
    await get().loadTranscript(sessionId);
  },

  applyUpdate: (payload) => {
    set({ busy: payload.busy });
    // A null sessionId means a fresh, empty session (e.g. "New chat"): there is
    // nothing to load, and reloading would resolve back to the PREVIOUS session
    // and clobber the just-cleared UI (the "click New chat twice" bug). Just
    // show an empty conversation.
    if (payload.sessionId === null) {
      set({
        currentSessionId: null,
        transcript: { sessionId: null, title: null, turns: [], busy: false },
        pendingUserMessage: null,
        liveTurn: null,
      });
      if (payload.sessionsChanged) void get().refreshSessions();
      return;
    }
    // Re-read the transcript for the affected session; also refresh the list
    // when the session set changed (new/selected/renamed).
    void get()
      .loadTranscript(payload.sessionId)
      .then(() => {
        // The turn is over and the durable transcript is loaded: drop the live
        // turn so we render one authoritative copy, not two.
        if (!payload.busy) set({ liveTurn: null });
        return undefined;
      });
    if (payload.sessionsChanged) void get().refreshSessions();
  },

  applyStreamEvent: (payload) => {
    set((state) => {
      const base = state.liveTurn ?? emptyLiveTurn();
      const next = reduceLiveTurn(base, payload.event);
      // The first streamed content means the assistant is answering — the
      // optimistic user bubble has served its purpose and the real transcript
      // will carry it, so keep it until the file reload settles it.
      return { liveTurn: next };
    });
  },
}));
