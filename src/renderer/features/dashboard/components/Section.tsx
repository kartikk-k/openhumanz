/**
 * A dashboard section — a quiet dimmed label over a boxless list.
 *
 * No card, no border, no fill. Structure comes from a small low-opacity label
 * and whitespace only, so the whole canvas reads as one calm surface (matching
 * Home's ambient "Upcoming next:" language rather than a grid of boxes).
 */
import type { ReactNode } from 'react';

interface SectionProps {
  label: string;
  children: ReactNode;
}

export function Section({ label, children }: SectionProps) {
  return (
    <section className="mb-10">
      <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-white/25">
        {label}
      </p>
      {children}
    </section>
  );
}

export default Section;
