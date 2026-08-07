import { useEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ROUTES } from '../../routes';
import { useAppBootstrap, useShouldOnboard } from '../../store';
import { Toaster } from '../ui/Toast';
import { ErrorBoundary } from '../shared/ErrorBoundary';
import { Sidebar } from './Sidebar';
import { EnvironmentBanner, StatusStrip } from './StatusStrip';

/**
 * The frame: sidebar, status strip, scrolling content.
 *
 * The window is a normal framed OS window — no custom titlebar, no drag
 * regions — so this component owns the full viewport and nothing above it.
 *
 * Onboarding redirect happens exactly once per session, and only after main has
 * actually answered `onboarding:get`. A missing handler must not trap anyone on
 * a setup screen, which is why `useShouldOnboard` distinguishes "not done" from
 * "not heard back".
 */
export function AppShell() {
  useAppBootstrap();

  const navigate = useNavigate();
  const location = useLocation();
  const shouldOnboard = useShouldOnboard();
  const redirected = useRef(false);

  useEffect(() => {
    if (!shouldOnboard || redirected.current) return;
    redirected.current = true;
    navigate(ROUTES.onboarding, { replace: true });
  }, [shouldOnboard, navigate]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <StatusStrip />
        <EnvironmentBanner />
        <main className="min-h-0 flex-1 overflow-y-auto">
          {/* Keyed by route so a crashed screen clears when you navigate away. */}
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
      <Toaster />
    </div>
  );
}

export default AppShell;
