import { Section } from './Section';
import { MESSAGES } from '../data';

export function MessagesCard() {
  return (
    <Section label="Messages">
      <ul className="space-y-3">
        {MESSAGES.map((message) => (
          <li key={message.id} className="group flex items-baseline gap-3">
            <span
              className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                message.unread ? 'bg-sky-400' : 'bg-transparent'
              }`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span
                  className={`truncate text-[13px] ${
                    message.unread
                      ? 'font-medium text-white/90'
                      : 'text-white/70'
                  }`}
                >
                  {message.from}
                </span>
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-white/30">
                  {message.time}
                </span>
              </div>
              <p className="truncate text-xs text-white/40">
                {message.preview}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export default MessagesCard;
