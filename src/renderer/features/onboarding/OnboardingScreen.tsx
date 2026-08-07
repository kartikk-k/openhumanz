import { useNavigate } from 'react-router-dom';
import { IPC } from '../../../shared/ipc';
import { ROUTES } from '../../routes';
import { APP_NAME } from '../../constants';
import { Button } from '../../components/ui/Button';
import { Placeholder } from '../../components/shared/Placeholder';
import { useOnboardingStore } from '../../store';

/**
 * PLACEHOLDER — replace this whole file.
 *
 * Owns `/onboarding`. Renders **outside** AppShell: no sidebar, no status
 * strip, full window. Anything here must leave the user a way out — the skip
 * button below is the minimum, keep an equivalent.
 */
export function OnboardingScreen() {
  const navigate = useNavigate();
  const dismiss = useOnboardingStore((state) => state.dismiss);
  const step = useOnboardingStore((state) => state.state.step);

  const skip = () => {
    dismiss();
    navigate(ROUTES.runs, { replace: true });
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-y-auto bg-white dark:bg-zinc-950">
      <header className="flex items-center justify-between px-5 py-3">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="flex h-5 w-5 items-center justify-center rounded bg-indigo-600 text-[10px] font-bold text-white"
          >
            A
          </span>
          <h1 className="text-[13px] font-semibold tracking-tight text-zinc-800 dark:text-zinc-100">
            Set up {APP_NAME}
          </h1>
          <span className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
            step: {step}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={skip}>
          Skip for now
        </Button>
      </header>

      <Placeholder
        filePath="src/renderer/features/onboarding/OnboardingScreen.tsx"
        summary="First run. Walk the five OnboardingStep values — welcome, engine, workspace, permissions, done — and persist progress after each one."
        requirements={[
          'engine: run engines:detect and show what was found, or the reason it was not. No CLI is a blocking state, but say so in plain words.',
          'workspace: show the resolved workspace root and confirm it can be created.',
          'permissions: list providers from engines:status with availability and reason. On Linux most are unavailable — that is expected, not an error.',
          'Warn loudly if apiKeyEnvDetected: a stray ANTHROPIC_API_KEY silently spends money. Set acknowledgedApiKeyWarning when dismissed.',
          'Persist each step with onboarding:set, and call complete() at the end.',
          'The shell only redirects here once per session, and only when main actually answered.',
        ]}
        channels={[
          IPC.onboarding.get,
          IPC.onboarding.set,
          IPC.engines.detect,
          IPC.engines.status,
          IPC.settings.get,
          IPC.settings.set,
        ]}
      />
    </div>
  );
}

export default OnboardingScreen;
