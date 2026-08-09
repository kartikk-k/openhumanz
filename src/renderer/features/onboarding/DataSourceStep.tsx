/**
 * Step 4 — memory and data sources.
 *
 * Memory now runs itself: a local engine builds a picture of you from your
 * conversations, on-device, with nothing to configure. So this step just says
 * that plainly and then shows an honest list of the OS data sources this machine
 * can and cannot reach.
 */
import { Brain } from 'lucide-react';
import { cn } from '../../lib/utils';
import { textSubtle } from '../../components/ui/styles';
import { Notice } from '../settings/Notice';
import { ProvidersPanel } from '../settings/EnvironmentPanel';

export function DataSourceStep() {
  return (
    <>
      <Notice
        tone="info"
        size="compact"
        icon={Brain}
        title="Memory works on its own"
      >
        <p>
          As you chat, the assistant quietly remembers the things that matter —
          your preferences, facts about you, decisions you make — and recalls
          them later. It all runs locally on this machine; nothing is uploaded
          and there is nothing to set up. You can review or clear what it has
          learned any time on the Memory screen.
        </p>
      </Notice>

      <div>
        <p className={cn('mb-1.5 text-[12.5px] leading-relaxed', textSubtle)}>
          Other sources — mail, calendar, reminders — are read through the OS
          rather than through an account you connect. Here is what this machine
          reports:
        </p>
        <ProvidersPanel />
      </div>
    </>
  );
}

export default DataSourceStep;
