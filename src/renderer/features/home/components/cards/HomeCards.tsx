/**
 * HomeCards — the home tag-protocol cards.
 *
 * These render structured data the assistant emits (via its tag protocol)
 * instead of prose. Each card receives a plain `attrs: Record<string, string>`
 * parsed straight from tag attributes — so every value arrives as a string and
 * numbers must be coerced (parseFloat / Number) and missing keys tolerated.
 *
 * The look matches the home / voice experience: near-black ambient glass,
 * white text at varying opacities, soft borders — the same visual language as
 * the ambient cards (UpcomingNext, CustomerHistory) and HomeApprovalCard.
 */
import {
  Cloud,
  CloudRain,
  CloudSnow,
  Sun,
  type LucideIcon,
} from 'lucide-react';

/** Pick a weather icon from a free-form condition string. Defaults to Cloud. */
function weatherIcon(condition: string): LucideIcon {
  const c = condition.toLowerCase();
  if (c.includes('rain') || c.includes('drizzle') || c.includes('shower')) {
    return CloudRain;
  }
  if (c.includes('snow') || c.includes('sleet') || c.includes('flurr')) {
    return CloudSnow;
  }
  if (c.includes('clear') || c.includes('sun') || c.includes('fair')) {
    return Sun;
  }
  return Cloud;
}

/** Format a temperature-ish string as "64°", tolerating missing/garbage input. */
function degrees(value: string | undefined): string | null {
  if (value == null || value.trim() === '') return null;
  const n = Number.parseFloat(value);
  if (Number.isNaN(n)) return null;
  return `${Math.round(n)}°`;
}

/**
 * WeatherCard — current conditions at a glance.
 * attrs: location, temp, unit (F/C), condition, high, low.
 */
export function WeatherCard({ attrs }: { attrs: Record<string, string> }) {
  const condition = attrs.condition ?? '';
  const Icon = weatherIcon(condition);
  const temp = degrees(attrs.temp);
  const high = degrees(attrs.high);
  const low = degrees(attrs.low);
  const unit = attrs.unit?.trim().toUpperCase();

  return (
    <div className="pointer-events-auto w-full max-w-[320px] overflow-hidden rounded-3xl border border-white/10 bg-white/[0.06] p-5 text-left backdrop-blur-xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-baseline gap-1">
            <span className="text-5xl font-light leading-none tracking-tight text-white">
              {temp ?? '—'}
            </span>
            {unit ? (
              <span className="text-sm font-medium text-white/40">{unit}</span>
            ) : null}
          </div>
          {condition ? (
            <p className="mt-2 text-sm text-white/70">{condition}</p>
          ) : null}
        </div>
        <Icon className="size-9 shrink-0 text-white/70" strokeWidth={1.5} />
      </div>

      {attrs.location?.trim() ? (
        <p className="mt-3 text-xs uppercase tracking-wider text-white/40">
          {attrs.location}
        </p>
      ) : null}

      {high || low ? (
        <p className="mt-1 text-xs text-white/50">
          {high ? `H:${high}` : null}
          {high && low ? '  ' : null}
          {low ? `L:${low}` : null}
        </p>
      ) : null}
    </div>
  );
}

type CalendarItem = { day?: string; time?: string; title?: string };

/**
 * CalendarWeekCard — a short list of upcoming calendar events.
 * attrs: items — a JSON string array like
 *   [{"day":"Mon","time":"9:30 AM","title":"Standup"}]
 * Parsed defensively; renders a subtle "No events" when empty/invalid.
 */
export function CalendarWeekCard({ attrs }: { attrs: Record<string, string> }) {
  let items: CalendarItem[] = [];
  try {
    const parsed: unknown = JSON.parse(attrs.items ?? '[]');
    if (Array.isArray(parsed)) {
      items = parsed.filter(
        (it): it is CalendarItem => typeof it === 'object' && it !== null,
      );
    }
  } catch {
    items = [];
  }

  return (
    <div className="pointer-events-auto w-full max-w-sm overflow-hidden rounded-3xl border border-white/10 bg-white/[0.06] p-4 text-left backdrop-blur-xl">
      <p className="px-1 text-[11px] uppercase tracking-wider text-white/40">
        This week
      </p>
      {items.length === 0 ? (
        <p className="mt-2 px-1 text-xs italic text-white/30">No events</p>
      ) : (
        <div className="mt-2 divide-y divide-white/10">
          {items.map((item) => (
            <div
              key={`${item.day ?? ''}-${item.time ?? ''}-${item.title ?? ''}`}
              className="flex flex-col gap-0.5 px-1 py-2.5"
            >
              <p className="text-[11px] text-white/50">
                {[item.day, item.time].filter(Boolean).join(' · ')}
              </p>
              {item.title ? (
                <p className="text-sm text-white/90">{item.title}</p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * ConfirmCard — a draft action awaiting the user's Send / Edit.
 * attrs: action (e.g. "Post to #general"), detail (the draft body), target.
 * onApprove / onEdit are optional callbacks; buttons render regardless.
 */
export function ConfirmCard({
  attrs,
  onApprove,
  onEdit,
}: {
  attrs: Record<string, string>;
  onApprove?: () => void;
  onEdit?: () => void;
}) {
  const action = attrs.action?.trim();
  const target = attrs.target?.trim();
  const detail = attrs.detail ?? '';

  return (
    <div className="pointer-events-auto w-full max-w-sm overflow-hidden rounded-3xl border border-white/10 bg-white/[0.06] p-5 text-left backdrop-blur-xl">
      {action || target ? (
        <p className="text-[11px] uppercase tracking-wider text-white/40">
          {action}
          {action && target ? ' · ' : null}
          {target ? <span className="text-white/60">{target}</span> : null}
        </p>
      ) : null}

      {detail.trim() ? (
        <div className="mt-3 rounded-2xl bg-black/20 p-3 text-sm leading-relaxed text-white/85">
          {detail}
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onApprove?.()}
          className="rounded-full bg-white/90 px-4 py-1.5 text-xs font-medium text-black transition hover:bg-white"
        >
          Send
        </button>
        <button
          type="button"
          onClick={() => onEdit?.()}
          className="rounded-full border border-white/15 px-4 py-1.5 text-xs font-medium text-white/80 transition hover:text-white"
        >
          Edit
        </button>
      </div>
    </div>
  );
}
