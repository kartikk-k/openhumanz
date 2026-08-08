/**
 * Step 2 — find the CLI, and confirm how it is authenticated.
 *
 * The whole reason this step exists as its own screen is the stray-API-key
 * case. An `ANTHROPIC_API_KEY` in the environment takes precedence over a
 * subscription login, so the user sees a healthy sign-in, believes they are on
 * their plan, and quietly burns pay-as-you-go credit instead. It is the one
 * setup problem that costs money and produces no error, so it is rendered
 * first, at full volume, above the engine list — and this step will not hand
 * out its Continue button until it has been acknowledged.
 */
import { Cpu, RefreshCw } from 'lucide-react';
import { cn } from '../../lib/utils';
import { textSubtle } from '../../components/ui/styles';
import { Button } from '../../components/ui';
import { useEnvironmentStore } from '../../store';
import { ApiKeyNotice } from '../settings/ApiKeyNotice';
import { EnvironmentPanel } from '../settings/EnvironmentPanel';
import { apiKeyFinding } from '../settings/environment';

export interface EngineStepProps {
  acknowledged: boolean;
  onAcknowledge: () => void;
}

export function EngineStep({ acknowledged, onAcknowledge }: EngineStepProps) {
  const environment = useEnvironmentStore((state) => state.environment);
  const status = useEnvironmentStore((state) => state.status);
  const load = useEnvironmentStore((state) => state.load);
  const detectEngines = useEnvironmentStore((state) => state.detectEngines);

  const finding = apiKeyFinding(environment);

  const recheck = async () => {
    await detectEngines(true);
    await load();
  };

  return (
    <>
      <ApiKeyNotice
        finding={finding}
        rechecking={status === 'loading'}
        acknowledged={acknowledged}
        onAcknowledge={onAcknowledge}
        onRecheck={() => {
          void recheck();
        }}
      />

      <EnvironmentPanel
        showProviders={false}
        showApiKeyWarning={false}
        refreshOnFocus
      />

      <div className="rounded-md border border-dashed border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
        <p
          className={cn('text-[12.5px] leading-relaxed', textSubtle)}
        >
          Nothing here installs or signs in for you, on purpose — those are your
          credentials and they belong in your own shell. If the CLI is missing,
          install it and press re-check; if it is installed but signed out, run{' '}
          <code className="rounded bg-zinc-900/[0.06] px-1 py-px font-mono text-[11.5px] dark:bg-white/10">
            claude auth login
          </code>{' '}
          once and come back. This screen re-checks itself every time the window
          regains focus.
        </p>
        <Button
          size="sm"
          variant="ghost"
          icon={RefreshCw}
          className="mt-2"
          loading={status === 'loading'}
          onClick={() => {
            void recheck();
          }}
        >
          Check again
        </Button>
      </div>
    </>
  );
}

export const EngineStepIcon = Cpu;

export default EngineStep;
