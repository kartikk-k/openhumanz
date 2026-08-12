import { Section } from './Section';
import { UPCOMING_EVENTS } from '../data';

export function UpcomingEventsCard() {
  return (
    <Section label="Upcoming">
      <ul className="space-y-3">
        {UPCOMING_EVENTS.map((event) => (
          <li key={event.id} className="group flex items-baseline gap-3">
            <span
              className={`shrink-0 self-center text-sm leading-none ${event.accent}`}
              aria-hidden="true"
            >
              •
            </span>
            <span className="w-16 shrink-0 text-xs tabular-nums text-white/40">
              {event.time}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[13px] text-white/75 transition-colors group-hover:text-white/95">
                {event.title}
              </p>
              <p className="text-[11px] text-white/30">
                {event.relative}
                {event.location ? ` · ${event.location}` : ''}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export default UpcomingEventsCard;
