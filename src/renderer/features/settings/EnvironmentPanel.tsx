/**
 * "What can this machine actually do right now?"
 *
 * One panel, shared by settings and by the onboarding engine step, so there is
 * a single answer to that question in the product.
 *
 * Three things it is careful about:
 *
 *  - **Unavailable is not broken.** The dev machine is Linux and the product
 *    targets macOS; most OS providers report `available: false` with a reason,
 *    and that renders as information, not as an error.
 *  - **Unreachable is not unavailable.** If the detector itself cannot be
 *    reached, the panel says so in those words. Rendering "no engine installed"
 *    when we simply failed to ask would send the user off to reinstall a CLI
 *    that is sitting right there.
 *  - **It re-checks on window focus.** Installing a CLI, signing in, or
 *    granting an OS permission all happen outside this app, and the user comes
 *    straight back expecting the screen to have noticed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  CircleSlash,
  Cpu,
  MinusCircle,
  PlugZap,
  RefreshCw,
  ShieldQuestion,
  TriangleAlert,
} from 'lucide-react';
import type { EngineInfo, ProviderAvailability } from '../../../shared/engines';
import { cn } from '../../lib/utils';
import { TONE_TEXT, type Tone } from '../../lib/tone';
import { formatRelative } from '../../lib/format';
import { isBridgeAvailable } from '../../lib/ipc';
import {
  Badge,
  Button,
  eyebrow,
  mono,
  textMuted,
  textSubtle,
} from '../../components/ui';
import {
  useEnvironmentStore,
  usePreferredEngine,
  useSettingsStore,
} from '../../store';
import { Notice, Ticks } from './Notice';
import { ApiKeyNotice } from './ApiKeyNotice';
import {
  activeEngineReason,
  apiKeyFinding,
  authSidecarOf,
  describeEngine,
  describeUnavailable,
  readEngineAuth,
  type EngineView,
} from './environment';

/* ------------------------------------------------------------------ */
/* Focus re-check                                                      */
/* ------------------------------------------------------------------ */

/** Do not re-probe more than once every 10 seconds of window focus churn. */
const FOCUS_THROTTLE_MS = 10_000;

/**
 * Run `callback` when the window regains focus, at most once per
 * {@link FOCUS_THROTTLE_MS}. Alt-tabbing back and forth must not spawn a
 * process every time.
 */
export function useRefreshOnFocus(callback: () => void, enabled = true): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const lastRef = useRef(0);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    const onFocus = () => {
      const now = Date.now();
      if (now - lastRef.current < FOCUS_THROTTLE_MS) return;
      lastRef.current = now;
      callbackRef.current();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [enabled]);
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

function EngineRow({ view, active }: { view: EngineView; active: boolean }) {
  const { engine, auth } = view;
  return (
    <li
      className={cn(
        'flex flex-wrap items-start gap-x-3 gap-y-1 rounded-md border px-3 py-2.5',
        active
          ? 'border-indigo-200 bg-indigo-50/50 dark:border-indigo-500/30 dark:bg-indigo-500/[0.07]'
          : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900',
      )}
    >
      <Cpu
        size={15}
        aria-hidden="true"
        className={cn('mt-0.5 shrink-0', TONE_TEXT[view.tone])}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
            {engine.name}
          </span>
          <Badge tone={view.tone} size="sm">
            {view.label}
          </Badge>
          {active ? (
            <Badge tone="accent" variant="outline" size="sm">
              Active
            </Badge>
          ) : null}
          {engine.version ? (
            <span className={cn(mono, textMuted)}>v{engine.version}</span>
          ) : null}
        </div>
        <p className={cn('mt-1 text-[12.5px] leading-relaxed', textSubtle)}>
          <Ticks text={view.detail} />
        </p>
        {auth?.email || auth?.organization || auth?.subscription ? (
          <p className={cn('mt-0.5 text-[12px]', textMuted)}>
            {[auth.email, auth.organization, auth.subscription]
              .filter(Boolean)
              .join(' · ')}
          </p>
        ) : null}
        {engine.binaryPath ? (
          <p className={cn('mt-1 truncate', mono, textMuted)}>
            {engine.binaryPath}
          </p>
        ) : null}
        {auth?.probeError ? (
          <p className={cn('mt-1 text-[12px]', TONE_TEXT.warning)}>
            <Ticks
              text={`Sign-in probe did not answer: ${auth.probeError}. The CLI itself is fine — only the check failed.`}
            />
          </p>
        ) : null}
      </div>
      <div className={cn('shrink-0 text-right', mono, textMuted)}>
        {engine.id}
      </div>
    </li>
  );
}

function ProviderRow({ provider }: { provider: ProviderAvailability }) {
  const blockedByPermission =
    provider.requiresPermission && provider.permissionGranted === false;

  let tone: Tone = 'success';
  let Icon = CheckCircle2;
  let label = 'Available';
  if (!provider.available) {
    if (blockedByPermission) {
      tone = 'warning';
      Icon = ShieldQuestion;
      label = 'Permission needed';
    } else {
      tone = 'neutral';
      Icon = MinusCircle;
      label = 'Not on this platform';
    }
  }

  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <Icon
        size={14}
        aria-hidden="true"
        className={cn('mt-0.5 shrink-0', TONE_TEXT[tone])}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[12.5px] font-medium text-zinc-800 dark:text-zinc-200">
            {provider.name}
          </span>
          <span className={cn('text-[11px]', TONE_TEXT[tone])}>{label}</span>
        </div>
        {provider.reason ? (
          <p className={cn('text-[12px] leading-relaxed', textMuted)}>
            <Ticks text={provider.reason} />
          </p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Just the OS data sources. Split out because the onboarding data-source step
 * wants this half without the engine half.
 */
export function ProvidersPanel({ className }: { className?: string }) {
  const environment = useEnvironmentStore((state) => state.environment);
  const providers = environment?.providers ?? [];
  const unreachable = [...providers].sort(
    (a, b) => Number(b.available) - Number(a.available),
  );

  return (
    <div
      className={cn(
        'rounded-md border border-zinc-200 px-3 py-2.5 dark:border-zinc-800',
        className,
      )}
    >
      <p className={eyebrow}>Data sources on this machine</p>
      {environment ? (
        <>
          <ul className="mt-1 divide-y divide-zinc-100 dark:divide-zinc-800/70">
            {unreachable.map((provider) => (
              <ProviderRow key={provider.id} provider={provider} />
            ))}
          </ul>
          {providers.length === 0 ? (
            <p className={cn('mt-1.5 text-[12.5px]', textMuted)}>
              No providers were reported.
            </p>
          ) : null}
          {providers.some((provider) => !provider.available) ? (
            <p className={cn('mt-2 text-[12px]', textMuted)}>
              Unavailable is a normal answer here — most of these are macOS
              apps, and this machine reports itself as{' '}
              <code className={mono}>{environment.platform}</code>.
            </p>
          ) : null}
        </>
      ) : (
        <p className={cn('mt-1.5 text-[12.5px]', textMuted)}>
          Nothing has been checked yet, so nothing is claimed here either way.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export interface EnvironmentPanelProps {
  /** OS provider availability. Onboarding's engine step hides it. */
  showProviders?: boolean;
  /** Onboarding renders the key warning itself, above the fold. */
  showApiKeyWarning?: boolean;
  /** Re-probe whenever the window regains focus. */
  refreshOnFocus?: boolean;
  className?: string;
}

export function EnvironmentPanel({
  showProviders = true,
  showApiKeyWarning = true,
  refreshOnFocus = true,
  className,
}: EnvironmentPanelProps) {
  const environment = useEnvironmentStore((state) => state.environment);
  const status = useEnvironmentStore((state) => state.status);
  const error = useEnvironmentStore((state) => state.error);
  const unavailable = useEnvironmentStore((state) => state.unavailable);
  const load = useEnvironmentStore((state) => state.load);
  const detectEngines = useEnvironmentStore((state) => state.detectEngines);
  const preferredId = useSettingsStore(
    (state) => state.settings.engine.preferred,
  );
  const active = usePreferredEngine(preferredId);

  const [busy, setBusy] = useState(false);

  const recheck = useCallback(async () => {
    setBusy(true);
    await detectEngines(true);
    await load();
    setBusy(false);
  }, [detectEngines, load]);

  useRefreshOnFocus(() => {
    void recheck();
  }, refreshOnFocus);

  const notice = describeUnavailable(
    { status, error, unavailable },
    isBridgeAvailable(),
    'Engine detection',
  );

  const sidecar = authSidecarOf(environment);
  const engines: EngineInfo[] = environment?.engines ?? [];
  const views = engines.map((engine) =>
    describeEngine(engine, readEngineAuth(engine, sidecar)),
  );
  const finding = apiKeyFinding(environment);

  return (
    <section className={cn('space-y-3', className)}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
            Engine &amp; environment
          </h3>
          <p className={cn('text-[12px]', textMuted)}>
            {environment
              ? `Checked ${formatRelative(environment.checkedAt)} · platform ${environment.platform}`
              : 'Not checked yet.'}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon={RefreshCw}
          loading={busy || status === 'loading'}
          onClick={() => {
            void recheck();
          }}
        >
          Re-detect
        </Button>
      </header>

      {notice ? (
        <Notice
          tone={notice.tone}
          icon={PlugZap}
          eyebrow="Not detected"
          title={notice.title}
          detail={notice.detail}
          detailLabel="bridge said"
          actions={
            notice.retryable ? (
              <Button
                size="sm"
                variant="secondary"
                icon={RefreshCw}
                loading={busy}
                onClick={() => {
                  void recheck();
                }}
              >
                Try again
              </Button>
            ) : null
          }
        >
          <p>{notice.body}</p>
          <p className="font-medium text-zinc-800 dark:text-zinc-200">
            This is not the same as “no agent CLI installed”. Nothing has been
            ruled out — the question was never asked.
          </p>
        </Notice>
      ) : null}

      {showApiKeyWarning ? (
        <ApiKeyNotice
          finding={finding}
          rechecking={busy}
          onRecheck={() => {
            void recheck();
          }}
        />
      ) : null}

      {!notice && engines.length === 0 ? (
        <Notice
          tone="warning"
          icon={CircleSlash}
          eyebrow="No engine"
          title="Detection ran and found no agent CLI"
          actions={
            <Button
              size="sm"
              variant="secondary"
              icon={RefreshCw}
              loading={busy}
              onClick={() => {
                void recheck();
              }}
            >
              Re-detect
            </Button>
          }
        >
          <p>
            <Ticks text="The detector answered, and its answer was empty: no `claude` binary on PATH and no explicit binary path set. Runs cannot start until one is found." />
          </p>
          <p>
            Install the Claude Code CLI, or set an explicit binary path in the
            Engine section below.
          </p>
        </Notice>
      ) : null}

      {views.length > 0 ? (
        <>
          <ul className="space-y-2">
            {views.map((view) => (
              <EngineRow
                key={view.engine.id}
                view={view}
                // "Active" means "this is what a run would spawn". An engine
                // that is not installed is never that, even when it is the
                // only one we know about and the preference points at it.
                active={active?.id === view.engine.id && view.engine.available}
              />
            ))}
          </ul>
          <p
            className={cn(
              'flex items-start gap-2 rounded-md border border-dashed px-3 py-2 text-[12.5px] leading-relaxed',
              'border-zinc-200 dark:border-zinc-800',
              textSubtle,
            )}
          >
            <TriangleAlert
              size={14}
              aria-hidden="true"
              className={cn(
                'mt-0.5 shrink-0',
                active?.available ? TONE_TEXT.neutral : TONE_TEXT.warning,
              )}
            />
            <span>
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                Why this engine:{' '}
              </span>
              <Ticks
                text={activeEngineReason(engines, preferredId, active ?? null)}
              />
            </span>
          </p>
        </>
      ) : null}

      {showProviders ? <ProvidersPanel /> : null}
    </section>
  );
}

export default EnvironmentPanel;
