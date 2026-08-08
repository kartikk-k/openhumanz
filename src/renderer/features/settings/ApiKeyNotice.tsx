/**
 * The stray-`ANTHROPIC_API_KEY` warning.
 *
 * This is deliberately the loudest thing either screen can show, and it is one
 * component rather than two so the settings screen and onboarding cannot
 * describe the same problem differently.
 *
 * Why it earns the volume: the CLI resolves an API key *before* a subscription
 * login. A user with a stray key sees a perfectly healthy `claude auth status`,
 * believes they are running on their plan, and is billed pay-as-you-go the
 * whole time. Nothing else in the product fails this quietly or this
 * expensively, so it gets a headline, the precedence rule stated outright, and
 * a copyable command.
 */
import { BadgeDollarSign, RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui';
import { Notice, Ticks } from './Notice';
import { apiKeyCopy, type ApiKeyFinding } from './environment';

export interface ApiKeyNoticeProps {
  finding: ApiKeyFinding;
  /** Re-run detection after the user has changed their shell. */
  onRecheck?: () => void;
  rechecking?: boolean;
  /**
   * Onboarding passes this so the step can be acknowledged and left behind.
   * Settings does not — there it stays until the machine actually changes.
   */
  onAcknowledge?: () => void;
  acknowledged?: boolean;
  className?: string;
}

export function ApiKeyNotice({
  finding,
  onRecheck,
  rechecking = false,
  onAcknowledge,
  acknowledged = false,
  className,
}: ApiKeyNoticeProps) {
  if (!finding.detected) return null;
  const copy = apiKeyCopy(finding);

  return (
    <Notice
      tone={copy.tone}
      icon={BadgeDollarSign}
      eyebrow={copy.eyebrow}
      title={copy.title}
      detail={copy.command}
      detailLabel="in your shell"
      className={className}
      actions={
        <>
          {onRecheck ? (
            <Button
              size="sm"
              variant="secondary"
              icon={RefreshCw}
              loading={rechecking}
              onClick={onRecheck}
            >
              Re-check
            </Button>
          ) : null}
          {onAcknowledge ? (
            <Button size="sm" variant="ghost" onClick={onAcknowledge}>
              {acknowledged ? 'Acknowledged' : 'I understand, continue anyway'}
            </Button>
          ) : null}
        </>
      }
    >
      <p>
        <Ticks text={copy.body} />
      </p>
      <p className="font-medium text-zinc-800 dark:text-zinc-200">
        <Ticks text={copy.status} />
      </p>
      <p>
        <Ticks text={copy.action} />
      </p>
    </Notice>
  );
}

export default ApiKeyNotice;
