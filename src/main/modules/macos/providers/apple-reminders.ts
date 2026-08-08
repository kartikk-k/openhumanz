/**
 * Apple Reminders as a `reminders` provider.
 *
 * Create only, and specifically no "mark complete". Completing a reminder is a
 * one-way edit to the user's own record of what they still have to do, and an
 * agent that is wrong about it removes something from the list with no trail. It
 * would also be the easiest write to grant `always` approval to and the one most
 * likely to be regretted.
 */
import { buildArgv, dateArgs } from '../escape';
import {
  ReminderCreatedSchema,
  ReminderSchema,
  RemindersListSchema,
} from '../schema';
import type { CapabilityOp } from '../version';
import {
  boolArg,
  checkAppleApp,
  optionalDate,
  supportsOp,
  type AppleProviderDeps,
} from './apple-base';
import type { CapabilityProvider, RemindersOps } from './types';

const OPS: readonly CapabilityOp[] = [
  'reminders.list',
  'reminders.reminder',
  'reminders.create',
];

export function createAppleRemindersProvider(
  deps: AppleProviderDeps,
): CapabilityProvider<'reminders'> {
  const operations: RemindersOps = {
    async list(input, ctx) {
      const result = await deps.runner.runScript({
        script: 'reminders-list',
        appId: 'reminders',
        args: buildArgv([
          input.list ?? '',
          input.limit,
          boolArg(input.includeCompleted),
        ]),
        schema: RemindersListSchema,
        signal: ctx.signal,
      });
      return {
        reminders: result.reminders.map((reminder) => ({
          ref: { id: reminder.id, scope: reminder.list },
          title: reminder.title,
          list: reminder.list,
          completed: reminder.completed,
          dueAt: optionalDate(reminder.dueAt),
          priority: reminder.priority,
        })),
        skippedCompleted: result.skippedCompleted,
        lists: result.lists,
      };
    },

    async reminder(input, ctx) {
      const result = await deps.runner.runScript({
        script: 'reminders-reminder',
        appId: 'reminders',
        args: buildArgv([input.ref.id, input.maxChars]),
        schema: ReminderSchema,
        signal: ctx.signal,
      });
      if (!result.found) return null;
      return {
        ref: { id: result.id, scope: result.list },
        title: result.title,
        list: result.list,
        completed: result.completed,
        dueAt: optionalDate(result.dueAt),
        remindAt: optionalDate(result.remindAt),
        priority: result.priority,
        body: result.body,
        bodyTruncated: result.bodyTruncated,
      };
    },

    async create(input, ctx) {
      const result = await deps.runner.runScript({
        script: 'reminders-create',
        appId: 'reminders',
        args: buildArgv([
          input.list ?? '',
          input.title,
          input.body,
          ...dateArgs(input.due),
        ]),
        schema: ReminderCreatedSchema,
        signal: ctx.signal,
      });
      return { id: result.id, list: result.list, title: result.title };
    },
  };

  return {
    id: 'apple-reminders',
    capability: 'reminders',
    name: 'Apple Reminders',
    tier: 'local-app',
    platforms: ['darwin'],
    ops: OPS,
    check: () => checkAppleApp('reminders', deps),
    supports: (op) => supportsOp(op, deps),
    operations,
  };
}
