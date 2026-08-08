/**
 * The fixed set of applications this module is ever allowed to talk to.
 *
 * This list is a security boundary, not a convenience. Automation permission on
 * macOS is granted per *source app / target app pair*, so every entry here is a
 * separate prompt the user will see naming our app and this target, and every
 * entry is a separate thing an attacker would like us to add one of. Nothing at
 * runtime may extend it: `escape.ts` refuses to interpolate an application name
 * that is not a key of {@link APPLE_APPS}, which is what makes
 * `tell application {{APP_NAME}}` safe to have in a script file at all.
 *
 * Bundle paths are here rather than discovered, for the same reason. `mdfind`
 * would let a user (or something writing to their disk) put any bundle behind
 * the name "Mail".
 */

/** Stable ids used in the database, in log lines and in permission rows. */
export const APPLE_APP_IDS = [
  'mail',
  'calendar',
  'contacts',
  'notes',
  'reminders',
  'finder',
  'systemevents',
] as const;

export type AppleAppId = (typeof APPLE_APP_IDS)[number];

export interface AppleAppDescriptor {
  id: AppleAppId;
  /**
   * Exactly the string that goes inside `tell application "..."`. Must be the
   * app's scripting name, not its localised display name — AppleScript resolves
   * by this name and a mismatch is an `-1728`, not a helpful error.
   */
  appleScriptName: string;
  bundleId: string;
  /** Absolute bundle locations, in the order they should be tried. */
  bundlePaths: string[];
  /** What the user calls it, for remediation copy. */
  displayName: string;
  /**
   * True when the app is part of the OS and effectively always present. A
   * missing bundle for one of these means something is very wrong with the
   * machine rather than "the user did not install it".
   */
  systemApp: boolean;
}

/**
 * Note the split bundle locations: Apple moved most of these out of
 * `/Applications` into `/System/Applications` in Catalina, and a machine
 * upgraded across that boundary can have either. Both are checked.
 */
export const APPLE_APPS: Record<AppleAppId, AppleAppDescriptor> = {
  mail: {
    id: 'mail',
    appleScriptName: 'Mail',
    bundleId: 'com.apple.mail',
    bundlePaths: ['/System/Applications/Mail.app', '/Applications/Mail.app'],
    displayName: 'Mail',
    systemApp: true,
  },
  calendar: {
    id: 'calendar',
    appleScriptName: 'Calendar',
    bundleId: 'com.apple.iCal',
    bundlePaths: [
      '/System/Applications/Calendar.app',
      '/Applications/Calendar.app',
    ],
    displayName: 'Calendar',
    systemApp: true,
  },
  contacts: {
    id: 'contacts',
    appleScriptName: 'Contacts',
    bundleId: 'com.apple.AddressBook',
    bundlePaths: [
      '/System/Applications/Contacts.app',
      '/Applications/Contacts.app',
    ],
    displayName: 'Contacts',
    systemApp: true,
  },
  notes: {
    id: 'notes',
    appleScriptName: 'Notes',
    bundleId: 'com.apple.Notes',
    bundlePaths: ['/System/Applications/Notes.app', '/Applications/Notes.app'],
    displayName: 'Notes',
    systemApp: true,
  },
  reminders: {
    id: 'reminders',
    appleScriptName: 'Reminders',
    bundleId: 'com.apple.reminders',
    bundlePaths: [
      '/System/Applications/Reminders.app',
      '/Applications/Reminders.app',
    ],
    displayName: 'Reminders',
    systemApp: true,
  },
  finder: {
    id: 'finder',
    appleScriptName: 'Finder',
    bundleId: 'com.apple.finder',
    bundlePaths: ['/System/Library/CoreServices/Finder.app'],
    displayName: 'Finder',
    systemApp: true,
  },
  systemevents: {
    id: 'systemevents',
    appleScriptName: 'System Events',
    bundleId: 'com.apple.systemevents',
    bundlePaths: [
      '/System/Library/CoreServices/System Events.app',
      '/System/Library/CoreServices/System Events.app/Contents/MacOS',
    ],
    displayName: 'System Events',
    systemApp: true,
  },
};

/** Every AppleScript application name we will ever emit. */
export const ALLOWED_APPLESCRIPT_NAMES: readonly string[] = Object.values(
  APPLE_APPS,
).map((app) => app.appleScriptName);

export function isAppleAppId(value: unknown): value is AppleAppId {
  return (
    typeof value === 'string' &&
    (APPLE_APP_IDS as readonly string[]).includes(value)
  );
}

export function appleApp(id: AppleAppId): AppleAppDescriptor {
  return APPLE_APPS[id];
}
