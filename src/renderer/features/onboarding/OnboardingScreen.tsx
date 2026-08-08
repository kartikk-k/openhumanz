/**
 * First run. Owns `/onboarding`, and renders **outside** AppShell — full
 * window, no sidebar, no status strip.
 *
 * Five steps: detect the CLI, confirm auth, pick a workspace folder, pick one
 * data source, run one successful task. That sequence is the argument the
 * product is making — if someone has to open a terminal or edit a TOML file to
 * get through it, the argument is already lost — so every step is operable from
 * this window, and the two places where it genuinely cannot be (installing a
 * CLI, signing in) say so outright instead of pretending.
 *
 * Two structural rules:
 *
 *  - **The escape hatch is always there.** "Skip for now" dismisses for the
 *    session and goes to Runs, on every step, and any step that blocks its own
 *    Continue button also offers a way past it. Nothing here is a trap.
 *  - **Progress is local first, persisted second.** `onboarding:set` may not be
 *    wired up yet; the flow keeps its own step state and treats persistence as
 *    best-effort, so a missing handler cannot pin someone to the welcome
 *    screen.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  Cpu,
  FolderTree,
  Library,
  Rocket,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import type { OnboardingStep } from '../../../shared/settings';
import { ROUTES } from '../../routes';
import { APP_NAME } from '../../constants';
import { cn } from '../../lib/utils';
import { textMuted } from '../../components/ui/styles';
import { Button } from '../../components/ui';
import {
  useAppBootstrap,
  useEnvironmentStore,
  useOnboardingStore,
  usePreferredEngine,
  useSettingsStore,
} from '../../store';
import {
  apiKeyFinding,
  authSidecarOf,
  readEngineAuth,
} from '../settings/environment';
import { BlockedReason, FLOW, StepShell, Stepper, stepIndex } from './chrome';
import { WelcomeStep } from './WelcomeStep';
import { EngineStep } from './EngineStep';
import { WorkspaceStep } from './WorkspaceStep';
import { DataSourceStep } from './DataSourceStep';
import { FirstRunStep } from './FirstRunStep';

const STEP_ICON: Record<OnboardingStep, LucideIcon> = {
  welcome: Sparkles,
  engine: Cpu,
  workspace: FolderTree,
  permissions: Library,
  done: Rocket,
};

interface Gate {
  ok: boolean;
  /** A full sentence. Rendered next to the way past it, never instead of one. */
  reason?: string;
}

const OPEN: Gate = { ok: true };

export function OnboardingScreen() {
  useAppBootstrap();

  const navigate = useNavigate();
  const persisted = useOnboardingStore((state) => state.state);
  const loaded = useOnboardingStore((state) => state.loaded);
  const update = useOnboardingStore((state) => state.update);
  const complete = useOnboardingStore((state) => state.complete);
  const dismiss = useOnboardingStore((state) => state.dismiss);

  const environment = useEnvironmentStore((state) => state.environment);
  const preferredId = useSettingsStore(
    (state) => state.settings.engine.preferred,
  );
  const engine = usePreferredEngine(preferredId);

  const [step, setStep] = useState<OnboardingStep>(persisted.step);
  const [adopted, setAdopted] = useState(false);

  // Adopt the persisted step exactly once, when main first answers. After that
  // the local value leads, so a later push cannot yank someone mid-sentence.
  useEffect(() => {
    if (adopted || !loaded) return;
    setAdopted(true);
    setStep(persisted.step === 'done' ? 'done' : persisted.step);
  }, [adopted, loaded, persisted.step]);

  const index = stepIndex(step);
  const entry = FLOW[index];
  const isLast = index === FLOW.length - 1;

  const go = useCallback(
    (next: OnboardingStep) => {
      setStep(next);
      void update({ step: next });
      if (typeof document !== 'undefined') {
        document.getElementById('onboarding-body')?.scrollTo({ top: 0 });
      }
    },
    [update],
  );

  const skip = () => {
    dismiss();
    navigate(ROUTES.runs, { replace: true });
  };

  const finish = () => {
    void complete();
    // Dismiss regardless: if `onboarding:set` is not wired up, `complete()`
    // silently fails and the shell would send us straight back here.
    dismiss();
    navigate(ROUTES.runs, { replace: true });
  };

  /* ---- gating ------------------------------------------------------ */

  const sidecar = authSidecarOf(environment);
  const engineAuth = engine ? readEngineAuth(engine, sidecar) : null;
  const finding = apiKeyFinding(environment);

  let gate: Gate = OPEN;
  if (step === 'engine') {
    if (finding.detected && !persisted.acknowledgedApiKeyWarning) {
      gate = {
        ok: false,
        reason:
          'Read the billing warning above and acknowledge it first. It is the one setup problem that costs real money and produces no error message.',
      };
    } else if (environment === null) {
      gate = {
        ok: false,
        reason:
          'Engine detection has not answered yet, so nothing has been found or ruled out. Press “Check again” — or continue and sort it out from Settings later.',
      };
    } else if (!engine?.available) {
      gate = {
        ok: false,
        reason: `No agent CLI was found on this machine${
          engine?.reason ? ` — ${engine.reason}` : ''
        }. Install it and press “Check again”; runs cannot start until one exists.`,
      };
    } else if (engineAuth?.state === 'logged-out') {
      gate = {
        ok: false,
        reason:
          'The CLI is installed but signed out. Run `claude auth login` in a terminal once, then press “Check again”.',
      };
    }
  }

  const next = () => {
    if (step === 'engine')
      void update({ engineDetected: engine?.available === true });
    if (step === 'workspace') void update({ workspaceReady: true });
    const following = FLOW[Math.min(index + 1, FLOW.length - 1)];
    go(following.id);
  };

  /* ---- body -------------------------------------------------------- */

  let body = <WelcomeStep />;
  if (step === 'engine') {
    body = (
      <EngineStep
        acknowledged={persisted.acknowledgedApiKeyWarning}
        onAcknowledge={() => {
          void update({ acknowledgedApiKeyWarning: true });
        }}
      />
    );
  } else if (step === 'workspace') {
    body = <WorkspaceStep />;
  } else if (step === 'permissions') {
    body = <DataSourceStep />;
  } else if (step === 'done') {
    body = (
      <FirstRunStep
        onSucceeded={() => {
          void update({ engineDetected: true });
        }}
      />
    );
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-white dark:bg-zinc-950">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
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
          <span className={cn('hidden text-[12px] sm:inline', textMuted)}>
            Step {index + 1} of {FLOW.length}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={skip}>
          Skip for now
        </Button>
      </header>

      <div className="shrink-0 border-b border-zinc-200 px-5 py-2 dark:border-zinc-800">
        <Stepper current={step} onJump={go} />
      </div>

      <main id="onboarding-body" className="min-h-0 flex-1 overflow-y-auto">
        <StepShell step={entry} icon={STEP_ICON[step]}>
          {body}
        </StepShell>
      </main>

      <footer className="flex shrink-0 flex-wrap items-center gap-3 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <Button
          variant="ghost"
          size="sm"
          icon={ArrowLeft}
          disabled={index === 0}
          onClick={() => go(FLOW[Math.max(index - 1, 0)].id)}
        >
          Back
        </Button>

        <div className="min-w-0 flex-1">
          {gate.reason ? <BlockedReason>{gate.reason}</BlockedReason> : null}
        </div>

        {isLast ? (
          <Button icon={Rocket} onClick={finish}>
            Finish setup
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            {gate.ok ? null : (
              <Button variant="ghost" size="sm" onClick={next}>
                Continue anyway
              </Button>
            )}
            <Button iconRight={ArrowRight} disabled={!gate.ok} onClick={next}>
              Continue
            </Button>
          </div>
        )}
      </footer>
    </div>
  );
}

export default OnboardingScreen;
