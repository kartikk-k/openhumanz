/**
 * Display formatting. Uses `Intl` — no date library (ARCHITECTURE.md: reach for
 * platform capabilities first).
 *
 * Every function tolerates undefined/garbage input and returns a dash, because
 * these render fields that the agent writes and the first-run state leaves
 * empty.
 */

const DASH = '—';

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function parse(iso: string | undefined | null): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `12 Aug 2026, 09:31` */
export function formatDateTime(iso?: string | null): string {
  const date = parse(iso);
  return date ? dateTimeFormat.format(date) : DASH;
}

/** `12 Aug 2026` */
export function formatDate(iso?: string | null): string {
  const date = parse(iso);
  return date ? dateFormat.format(date) : DASH;
}

/** `09:31:04` — for event timelines, where seconds matter. */
export function formatTime(iso?: string | null): string {
  const date = parse(iso);
  return date ? timeFormat.format(date) : DASH;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
  ['second', 1000],
];

/** `3 minutes ago`, `in 2 hours`, `just now`. */
export function formatRelative(iso?: string | null, now = Date.now()): string {
  const date = parse(iso);
  if (!date) return DASH;
  const delta = date.getTime() - now;
  if (Math.abs(delta) < 45_000) return 'just now';
  const unit = UNITS.find(([, ms]) => Math.abs(delta) >= ms);
  if (!unit) return 'just now';
  return relative.format(Math.round(delta / unit[1]), unit[0]);
}

/** `1.4s`, `2m 05s`, `1h 12m`. Compact enough for a table cell. */
export function formatDuration(ms?: number | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) {
    return DASH;
  }
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Elapsed time between two ISO stamps, falling back to now. */
export function formatElapsed(startIso?: string | null, endIso?: string | null): string {
  const start = parse(startIso);
  if (!start) return DASH;
  const end = parse(endIso) ?? new Date();
  return formatDuration(end.getTime() - start.getTime());
}

/** `$0.0123` / `$1.42`. Sub-cent costs are the common case here. */
export function formatCost(usd?: number | null): string {
  if (usd === undefined || usd === null || !Number.isFinite(usd)) return DASH;
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** `1,024` / `12.4k` / `1.2M` — token counts get large. */
export function formatCount(value?: number | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return DASH;
  }
  if (Math.abs(value) < 1000) return String(value);
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) {
    return DASH;
  }
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Clip to `max` characters with an ellipsis. Never mid-word if avoidable. */
export function truncate(value: string, max = 80): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Stable, readable JSON for tool arguments and raw payloads. */
export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** `3 runs` / `1 run` — the plural you write forty times a screen. */
export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

export { DASH };
