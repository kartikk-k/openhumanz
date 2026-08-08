/**
 * Apple Calendar as a `calendar` provider.
 *
 * `recurring` on a summary is derived from the event carrying a recurrence rule
 * at all, and `recurringExpanded` on the result is always false. Both are
 * reported rather than hidden because a calendar view that quietly omits the
 * weekly standup is worse than one that says it cannot see recurrences.
 */
import { buildArgv, dateArgs } from '../escape';
import {
  CalendarCreatedSchema,
  CalendarEventSchema,
  CalendarEventsSchema,
  CalendarsSchema,
} from '../schema';
import type { CapabilityOp } from '../version';
import {
  boolArg,
  checkAppleApp,
  optionalDate,
  supportsOp,
  type AppleProviderDeps,
} from './apple-base';
import type { CalendarOps, CapabilityProvider } from './types';

const OPS: readonly CapabilityOp[] = [
  'calendar.calendars',
  'calendar.events',
  'calendar.event',
  'calendar.create-event',
];

export function createAppleCalendarProvider(
  deps: AppleProviderDeps,
): CapabilityProvider<'calendar'> {
  const operations: CalendarOps = {
    async calendars(ctx) {
      const result = await deps.runner.runScript({
        script: 'calendar-calendars',
        appId: 'calendar',
        schema: CalendarsSchema,
        signal: ctx.signal,
      });
      return { calendars: result.calendars };
    },

    async events(input, ctx) {
      const result = await deps.runner.runScript({
        script: 'calendar-events',
        appId: 'calendar',
        args: buildArgv([
          input.calendar ?? '',
          input.limit,
          ...dateArgs(input.start),
          ...dateArgs(input.end),
        ]),
        schema: CalendarEventsSchema,
        signal: ctx.signal,
      });
      return {
        events: result.events.map((event) => ({
          ref: { id: event.uid, scope: event.calendar },
          title: event.title,
          calendar: event.calendar,
          location: event.location,
          startsAt: optionalDate(event.startsAt),
          endsAt: optionalDate(event.endsAt),
          allDay: event.allDay,
          recurring: event.recurrence !== '',
        })),
        limitReached: result.limitReached,
        recurringExpanded: result.recurringExpanded,
      };
    },

    async event(input, ctx) {
      const result = await deps.runner.runScript({
        script: 'calendar-event',
        appId: 'calendar',
        args: buildArgv([input.ref.id, input.maxChars]),
        schema: CalendarEventSchema,
        signal: ctx.signal,
      });
      if (!result.found) return null;
      return {
        ref: { id: result.uid, scope: result.calendar },
        title: result.title,
        calendar: result.calendar,
        location: result.location,
        startsAt: optionalDate(result.startsAt),
        endsAt: optionalDate(result.endsAt),
        allDay: result.allDay,
        recurring: result.recurrence !== '',
        notes: result.notes,
        notesTruncated: result.notesTruncated,
      };
    },

    async createEvent(input, ctx) {
      const result = await deps.runner.runScript({
        script: 'calendar-create-event',
        appId: 'calendar',
        args: buildArgv([
          input.calendar ?? '',
          input.title,
          input.location,
          input.notes,
          boolArg(input.allDay),
          ...dateArgs(input.start),
          ...dateArgs(input.end),
        ]),
        schema: CalendarCreatedSchema,
        signal: ctx.signal,
      });
      return { uid: result.uid, calendar: result.calendar };
    },
  };

  return {
    id: 'apple-calendar',
    capability: 'calendar',
    name: 'Apple Calendar',
    tier: 'local-app',
    platforms: ['darwin'],
    ops: OPS,
    check: () => checkAppleApp('calendar', deps),
    supports: (op) => supportsOp(op, deps),
    operations,
  };
}
