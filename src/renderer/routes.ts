/**
 * The app's information architecture, in one place.
 *
 * Six primary destinations plus onboarding. Nav labels, icons and paths are
 * declared here so the sidebar, the status strip and any deep link agree on
 * what a route is called.
 *
 * Each feature route is a splat (`/runs/*`) — the screen owns everything below
 * its own prefix, so a feature can add a detail view (`/runs/:runId`) without
 * touching the shell.
 */
import {
  Activity,
  CalendarClock,
  LayoutDashboard,
  Library,
  ListTodo,
  MessageSquare,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

export const ROUTES = {
  chat: '/chat',
  runs: '/runs',
  tasks: '/tasks',
  schedule: '/schedule',
  memory: '/memory',
  approvals: '/approvals',
  settings: '/settings',
  /** A blank full-window scratch page, rendered outside the app shell. */
  home: '/home',
  onboarding: '/onboarding',
} as const;

export type RouteKey = keyof typeof ROUTES;

export interface NavItem {
  key: Exclude<RouteKey, 'onboarding'>;
  path: string;
  label: string;
  icon: LucideIcon;
  /** One line, used as the sidebar tooltip and the default page subtitle. */
  description: string;
  /** Renders the pending-approvals count. Only Approvals sets it. */
  badge?: 'approvals';
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'home',
    path: ROUTES.home,
    label: 'Home',
    icon: LayoutDashboard,
    description: 'A blank canvas to experiment on.',
  },
  {
    key: 'chat',
    path: ROUTES.chat,
    label: 'Chat',
    icon: MessageSquare,
    description: 'Talk to the assistant directly and ask it to do things.',
  },
  {
    key: 'runs',
    path: ROUTES.runs,
    label: 'Runs',
    icon: Activity,
    description: 'Everything the assistant has done, step by step.',
  },
  {
    key: 'tasks',
    path: ROUTES.tasks,
    label: 'Tasks',
    icon: ListTodo,
    description: 'Work in flight, and the goals it belongs to.',
  },
  {
    key: 'schedule',
    path: ROUTES.schedule,
    label: 'Schedule',
    icon: CalendarClock,
    description: 'Recurring jobs, when they next fire, how they last went.',
  },
  {
    key: 'memory',
    path: ROUTES.memory,
    label: 'Memory',
    icon: Library,
    description: 'The vault, as files — because it is files.',
  },
  {
    key: 'approvals',
    path: ROUTES.approvals,
    label: 'Approvals',
    icon: ShieldCheck,
    description:
      'Actions waiting on you, and the standing grants you have given.',
    badge: 'approvals',
  },
  {
    key: 'settings',
    path: ROUTES.settings,
    label: 'Settings',
    icon: Settings,
    description: 'Engine, workspace, approvals, notifications.',
  },
];

/** The nav item a pathname belongs to, or undefined for onboarding/unknown. */
export function navItemForPath(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find(
    (item) => pathname === item.path || pathname.startsWith(`${item.path}/`),
  );
}
