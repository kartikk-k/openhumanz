import {
  MemoryRouter as Router,
  Navigate,
  Route,
  Routes,
} from 'react-router-dom';
import { ROUTES } from './routes';
import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/shared/ErrorBoundary';
import { BotsScreen } from './features/bots/BotsScreen';
import { ChatScreen } from './features/chat/ChatScreen';
import { RunsScreen } from './features/runs/RunsScreen';
import { TasksScreen } from './features/tasks/TasksScreen';
import { ScheduleScreen } from './features/schedule/ScheduleScreen';
import { MemoryScreen } from './features/memory/MemoryScreen';
import { ApprovalsScreen } from './features/approvals/ApprovalsScreen';
import { SettingsScreen } from './features/settings/SettingsScreen';
import { OnboardingScreen } from './features/onboarding/OnboardingScreen';
import { HomeScreen } from './features/home/HomeScreen';
import { DashboardScreen } from './features/dashboard/DashboardScreen';
import './App.css';

/**
 * Routing.
 *
 * `MemoryRouter` on purpose — this is a desktop window, not a website. There is
 * no address bar, no reload, no deep link from outside, and a history stack in
 * memory is exactly the model a native app has.
 *
 * Every feature route is a splat: the screen owns everything under its prefix,
 * so a feature can add detail views without editing this file.
 *
 * Onboarding sits outside AppShell — full window, no sidebar.
 */
export default function App() {
  return (
    <ErrorBoundary title="The app failed to start">
      {/* <GradientShader className="fixed inset-0 select-none opacity-50" /> */}

      <Router initialEntries={[ROUTES.chat]}>
        <Routes>
          <Route path={ROUTES.onboarding} element={<OnboardingScreen />} />
          {/* Home is a blank scratch page — full window, no shell. */}
          <Route path={`${ROUTES.home}/*`} element={<HomeScreen />} />
          {/* Dashboard prototype — full window overview, no shell. */}
          <Route path={`${ROUTES.dashboard}/*`} element={<DashboardScreen />} />

          <Route element={<AppShell />}>
            <Route path="/" element={<Navigate to={ROUTES.chat} replace />} />
            <Route path={`${ROUTES.chat}/*`} element={<BotsScreen />} />
            <Route path={`${ROUTES.sessions}/*`} element={<ChatScreen />} />
            <Route path={`${ROUTES.runs}/*`} element={<RunsScreen />} />
            <Route path={`${ROUTES.tasks}/*`} element={<TasksScreen />} />
            <Route path={`${ROUTES.schedule}/*`} element={<ScheduleScreen />} />
            <Route path={`${ROUTES.memory}/*`} element={<MemoryScreen />} />
            <Route
              path={`${ROUTES.approvals}/*`}
              element={<ApprovalsScreen />}
            />
            <Route path={`${ROUTES.settings}/*`} element={<SettingsScreen />} />
            <Route path="*" element={<Navigate to={ROUTES.chat} replace />} />
          </Route>
        </Routes>
      </Router>
    </ErrorBoundary>
  );
}
