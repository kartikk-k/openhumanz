/**
 * The bots module's slice of the IPC surface.
 *
 * Channel names come from `shared/ipc.ts` so a typo is a compile error rather
 * than a dead channel. Handlers stay thin: parse the request, delegate to the
 * store or the thread runner, return.
 *
 * Store and runner are getters because the registry binds this map at
 * construction, before `start()` has created either one.
 */
import { nowIso } from '../../../shared/common';
import { IPC } from '../../../shared/ipc';
import {
  BotCreateSchema,
  BotMarkReadRequestSchema,
  BotMessagesQuerySchema,
  BotSendRequestSchema,
  BotUpdateSchema,
  MAIN_BOT_ID,
  type BotWithUnread,
} from '../../../shared/bots';
import type { EventBus } from '../../infra/events';
import type { IpcHandlerMap } from '../types';
import type { BotStore } from './store';
import type { ThreadRunner } from './thread-runner';

/** Re-read one bot as a {@link BotWithUnread} row for a mutation's response. */
function botWithUnread(store: BotStore, id: string): BotWithUnread | null {
  return store.listBots(true).find((bot) => bot.id === id) ?? null;
}

export function createIpcHandlers(
  getStore: () => BotStore,
  getRunner: () => ThreadRunner,
  events: EventBus,
): IpcHandlerMap {
  return {
    [IPC.bots.list]: (request) =>
      getStore().listBots(request?.includeArchived ?? false),

    [IPC.bots.get]: ({ id }) => botWithUnread(getStore(), id),

    [IPC.bots.messages]: (request) => {
      const query = BotMessagesQuerySchema.parse(request);
      return {
        botId: query.botId,
        messages: getStore().listMessages(query.botId, {
          limit: query.limit,
          offset: query.offset,
        }),
      };
    },

    [IPC.bots.create]: (request) => {
      const store = getStore();
      const patch = BotCreateSchema.parse(request);
      const bot = store.createBot({
        name: patch.name,
        avatar_color: patch.avatarColor,
        system_prompt: patch.systemPrompt,
        allowed_tools_json: patch.allowedTools,
        workspace_dir: patch.workspaceDir,
        archived: patch.archived,
        metadata_json: patch.metadata,
      });
      events.emit('bots:thread', { botId: bot.id, rosterChanged: true });
      return botWithUnread(store, bot.id)!;
    },

    [IPC.bots.update]: (request) => {
      const store = getStore();
      const patch = BotUpdateSchema.parse(request);
      const { id, ...rest } = patch;
      // Map the domain patch to store columns, omitting absent keys so a patch
      // stays a patch (see the BotUpdateSchema note about not using .partial()).
      const columns: Record<string, unknown> = {};
      if (rest.name !== undefined) columns.name = rest.name;
      if (rest.avatarColor !== undefined)
        columns.avatar_color = rest.avatarColor;
      if (rest.systemPrompt !== undefined)
        columns.system_prompt = rest.systemPrompt;
      if (rest.allowedTools !== undefined)
        columns.allowed_tools_json = rest.allowedTools;
      if (rest.workspaceDir !== undefined)
        columns.workspace_dir = rest.workspaceDir;
      if (rest.archived !== undefined) columns.archived = rest.archived;
      if (rest.metadata !== undefined) columns.metadata_json = rest.metadata;
      const updated = store.updateBot(id, columns);
      if (!updated) throw new Error(`Unknown bot: ${id}`);
      events.emit('bots:thread', { botId: id, rosterChanged: true });
      return botWithUnread(store, id)!;
    },

    [IPC.bots.archive]: ({ id }) => {
      const store = getStore();
      // The Main bot is the promoted home chat; it must always exist.
      if (id === MAIN_BOT_ID) {
        throw new Error('The Main bot cannot be archived.');
      }
      const archived = store.archiveBot(id);
      if (archived)
        events.emit('bots:thread', { botId: id, rosterChanged: true });
      return { id, deleted: archived };
    },

    [IPC.bots.send]: async (request) => {
      const parsed = BotSendRequestSchema.parse(request);
      const result = await getRunner().sendToBot({
        botId: parsed.botId,
        prompt: parsed.prompt,
        source: parsed.source,
        author: parsed.author,
      });
      return {
        botId: result.botId,
        runId: result.runId,
        accepted: result.accepted,
      };
    },

    [IPC.bots.markRead]: (request) => {
      const store = getStore();
      const parsed = BotMarkReadRequestSchema.parse(request);
      store.markRead(parsed.botId, parsed.atIso ?? nowIso());
      // Deliberately DO NOT emit 'bots:thread' here. Marking a thread read is a
      // local read-cursor move, not a thread change — and emitting would loop:
      // push -> applyThreadPush -> markRead -> emit -> push -> ... (hundreds of
      // DB writes per second, each persisting the whole database). The caller
      // gets the fresh unread count in the response and updates its own state.
      return { botId: parsed.botId, unread: store.unreadCount(parsed.botId) };
    },
  };
}
