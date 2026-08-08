/**
 * A small, dependency-free fuzzy search for the Settings page.
 *
 * Settings is one long page with ten sections and many options inside them, so
 * typing "dark", "cron", "retention" or "api key" should jump you straight to
 * the right place. We index each section by its label plus a handful of
 * keywords (the field names and synonyms a person would actually type), and
 * score matches with a subsequence matcher that rewards contiguous, word-start
 * and early hits — the same shape as an editor's command palette.
 */

export interface SettingsSearchEntry {
  /** The section id to scroll to (matches the DOM element id). */
  id: string;
  /** The section's display label. */
  label: string;
  /** Words a user might type to find this section. */
  keywords: string[];
}

/**
 * The searchable index. Keywords are the field labels and the words people
 * reach for — kept here next to the sections they describe so it stays in sync
 * as options are added.
 */
export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  {
    id: 'environment',
    label: 'Environment',
    keywords: [
      'engine',
      'claude code',
      'codex',
      'cli',
      'detected',
      'version',
      'signed in',
      'auth',
      'account',
      'plan',
      'binary',
      'path',
      'data sources',
      'providers',
      're-detect',
    ],
  },
  {
    id: 'privacy',
    label: 'Privacy',
    keywords: [
      'telemetry',
      'analytics',
      'tracking',
      'account',
      'local',
      'offline',
      'data',
      'server',
      'phone home',
    ],
  },
  {
    id: 'workspace',
    label: 'Workspace',
    keywords: [
      'folder',
      'directory',
      'data location',
      'workspace root',
      'storage',
      'path',
      'where data lives',
      'move',
    ],
  },
  {
    id: 'engine',
    label: 'Engine',
    keywords: [
      'model',
      'preferred engine',
      'claude',
      'opus',
      'sonnet',
      'max turns',
      'cost',
      'budget',
      'ceiling',
      'timeout',
      'default engine',
    ],
  },
  {
    id: 'approvals',
    label: 'Approvals',
    keywords: [
      'permission',
      'grants',
      'auto approve',
      'side effect',
      'gate',
      'allow',
      'deny',
      'confirm',
      'safety',
      'tools',
    ],
  },
  {
    id: 'memory',
    label: 'Memory',
    keywords: [
      'vault',
      'notes',
      'markdown',
      'index',
      'search',
      'embeddings',
      'directory',
      'reindex',
      'chunks',
    ],
  },
  {
    id: 'schedule',
    label: 'Schedule',
    keywords: [
      'cron',
      'timezone',
      'time zone',
      'recurring',
      'jobs',
      'routines',
      'interval',
      'when',
    ],
  },
  {
    id: 'interface',
    label: 'Interface',
    keywords: [
      'theme',
      'dark mode',
      'light mode',
      'appearance',
      'ui',
      'display',
      'font',
      'density',
      'window',
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    keywords: [
      'alerts',
      'sound',
      'banner',
      'push',
      'notify',
      'desktop',
      'when a run finishes',
      'approval waiting',
    ],
  },
  {
    id: 'logging',
    label: 'Logging',
    keywords: [
      'logs',
      'log level',
      'verbose',
      'debug',
      'retention',
      'rotate',
      'rotation',
      'file size',
      'diagnostics',
    ],
  },
];

/**
 * Score `query` against `text`. Returns a number in (0, 1] on a subsequence
 * match, or 0 on no match. Higher is better: contiguous runs, word-start hits
 * and early matches all raise the score.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) {
    // Exact substring: strong, and stronger when it starts a word or the text.
    const at = t.indexOf(q);
    const wordStart = at === 0 || /\s/.test(t[at - 1] ?? '');
    return 0.8 + (wordStart ? 0.2 : 0.1) - Math.min(at, 20) / 200;
  }

  let qi = 0;
  let score = 0;
  let streak = 0;
  let prevMatchIndex = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      streak = ti === prevMatchIndex + 1 ? streak + 1 : 1;
      const wordStart = ti === 0 || /\s/.test(t[ti - 1] ?? '');
      score += 1 + streak * 0.5 + (wordStart ? 1 : 0);
      prevMatchIndex = ti;
      qi += 1;
    }
  }
  if (qi < q.length) return 0; // not all query chars matched, in order
  // Normalise to (0, 0.75] so a subsequence match always ranks below a
  // substring match.
  const max = q.length * 3.5;
  return Math.min(0.75, score / max);
}

/** Best score of the query against a section's label + keywords. */
export function scoreEntry(query: string, entry: SettingsSearchEntry): number {
  let best = fuzzyScore(query, entry.label) * 1.2; // label matches count most
  for (const keyword of entry.keywords) {
    best = Math.max(best, fuzzyScore(query, keyword));
  }
  return best;
}

/**
 * Rank sections by relevance to `query`. Empty query returns every section in
 * its original order. Only matches (score > 0) are returned otherwise, best
 * first.
 */
export function searchSettings(
  query: string,
): { entry: SettingsSearchEntry; score: number }[] {
  if (!query.trim()) {
    return SETTINGS_SEARCH_INDEX.map((entry) => ({ entry, score: 1 }));
  }
  return SETTINGS_SEARCH_INDEX.map((entry) => ({
    entry,
    score: scoreEntry(query, entry),
  }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
}
