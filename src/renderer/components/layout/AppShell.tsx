import { useEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ROUTES } from '../../routes';
import {
  useAppBootstrap,
  useOnboardingStore,
  useShouldOnboard,
} from '../../store';
import { Toaster } from '../ui/Toast';
import { ErrorBoundary } from '../shared/ErrorBoundary';
import { Sidebar } from './Sidebar';
import { EnvironmentBanner, StatusStrip } from './StatusStrip';
import GradientShader from '../../features/home/Background';

/**
 * The frame: sidebar, status strip, scrolling content.
 *
 * The window is a frameless macOS window with vibrancy — the background is
 * transparent so the OS blur shows through, and this shell paints its own
 * translucent surfaces on top. The top strip is a `.draggable-region` so the
 * window can be moved even without a system titlebar.
 *
 * Onboarding redirect happens exactly once per session, and only after main has
 * actually answered `onboarding:get`. A missing handler must not trap anyone on
 * a setup screen, which is why `useShouldOnboard` distinguishes "not done" from
 * "not heard back". While that answer is still pending we render nothing behind
 * the redirect, so a first-launch user never sees the feature screens flash
 * their "not set up yet" errors before setup opens.
 */
export function AppShell() {
  useAppBootstrap();

  const navigate = useNavigate();
  const location = useLocation();
  const shouldOnboard = useShouldOnboard();
  // Have we heard back from main about onboarding yet? Until we have, hold the
  // content so we don't paint error-laden screens and then redirect away.
  const onboardingResolved = useOnboardingStore(
    (slice) => slice.loaded || slice.status === 'error' || slice.unavailable,
  );
  const redirected = useRef(false);

  useEffect(() => {
    if (!shouldOnboard || redirected.current) return;
    redirected.current = true;
    navigate(ROUTES.onboarding, { replace: true });
  }, [shouldOnboard, navigate]);

  return (
    <div className="flex relative z-20 h-screen w-screen overflow-hidden text-zinc-900 antialiased dark:text-zinc-100">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <StatusStrip />
        <EnvironmentBanner />
        <main className="min-h-0 flex-1 overflow-y-auto">
          {/* Keyed by route so a crashed screen clears when you navigate away.
              Held until onboarding is resolved (or we're already past it) to
              avoid a flash of un-set-up feature screens on first launch. */}
          {onboardingResolved || location.pathname !== ROUTES.chat ? (
            <ErrorBoundary key={location.pathname}>
              <Outlet />
            </ErrorBoundary>
          ) : null}
        </main>
      </div>
      <Toaster />
    </div>
  );
}

export default AppShell;
