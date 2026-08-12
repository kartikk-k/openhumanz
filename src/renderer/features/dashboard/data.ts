/**
 * Dummy data for the Dashboard prototype.
 *
 * Everything here is hardcoded on purpose — the Dashboard is a design
 * exploration and is NOT wired to any store, IPC channel or live source.
 * Swap these arrays for real feeds later; the components read only from here.
 */

export interface UpcomingEvent {
  id: string;
  time: string;
  relative: string;
  title: string;
  location?: string;
  accent: string; // tailwind text color for the dot
}

export interface Reminder {
  id: string;
  title: string;
  due: string;
  done: boolean;
  priority: 'low' | 'medium' | 'high';
}

export interface Message {
  id: string;
  from: string;
  preview: string;
  time: string;
  unread: boolean;
  channel: 'imessage' | 'email' | 'slack';
}

export interface RunningTask {
  id: string;
  title: string;
  detail: string;
  progress: number; // 0..100
  startedAt: string;
}

export interface CompletedTask {
  id: string;
  title: string;
  finishedAt: string;
  outcome: 'success' | 'failed';
}

export interface Workflow {
  id: string;
  name: string;
  schedule: string;
  nextRun: string;
  status: 'active' | 'paused';
  lastRun: 'success' | 'failed' | 'never';
}

export const UPCOMING_EVENTS: UpcomingEvent[] = [
  {
    id: 'e1',
    time: '9:30 AM',
    relative: 'in 5 mins',
    title: 'Standup with core team',
    location: 'Google Meet',
    accent: 'text-emerald-400',
  },
  {
    id: 'e2',
    time: '12:00 PM',
    relative: 'in 2 hours',
    title: "Review Aisha's design doc",
    location: 'Notion',
    accent: 'text-sky-400',
  },
  {
    id: 'e3',
    time: '3:30 PM',
    relative: 'in 5 hours',
    title: '1:1 with Priya',
    location: 'Zoom',
    accent: 'text-violet-400',
  },
  {
    id: 'e4',
    time: '6:00 PM',
    relative: 'this evening',
    title: 'Gym — leg day',
    accent: 'text-amber-400',
  },
];

export const REMINDERS: Reminder[] = [
  {
    id: 'r1',
    title: 'Reply to the investor update thread',
    due: 'Today',
    done: false,
    priority: 'high',
  },
  {
    id: 'r2',
    title: 'Renew the domain (openhumanz.com)',
    due: 'Tomorrow',
    done: false,
    priority: 'medium',
  },
  {
    id: 'r3',
    title: 'Book flights for the offsite',
    due: 'This week',
    done: false,
    priority: 'medium',
  },
  {
    id: 'r4',
    title: 'Pick up groceries',
    due: 'Today',
    done: true,
    priority: 'low',
  },
  {
    id: 'r5',
    title: 'Sign the contractor agreement',
    due: 'Fri',
    done: false,
    priority: 'high',
  },
];

export const MESSAGES: Message[] = [
  {
    id: 'm1',
    from: 'Aisha Khan',
    preview: 'Sent over the v2 mocks — lmk what you think about the nav',
    time: '2m',
    unread: true,
    channel: 'slack',
  },
  {
    id: 'm2',
    from: 'Mom',
    preview: 'Are you coming home this weekend? ❤️',
    time: '18m',
    unread: true,
    channel: 'imessage',
  },
  {
    id: 'm3',
    from: 'Stripe',
    preview: 'Your payout of $4,210.00 is on the way',
    time: '1h',
    unread: false,
    channel: 'email',
  },
  {
    id: 'm4',
    from: 'Daniel Okafor',
    preview: 'Can we push the sync to 4pm? Something came up.',
    time: '3h',
    unread: false,
    channel: 'imessage',
  },
];

export const RUNNING_TASKS: RunningTask[] = [
  {
    id: 't1',
    title: 'Summarizing this week’s customer calls',
    detail: 'Processing 12 of 18 transcripts',
    progress: 66,
    startedAt: '4 min ago',
  },
  {
    id: 't2',
    title: 'Drafting the Q3 board deck',
    detail: 'Pulling metrics from the analytics warehouse',
    progress: 28,
    startedAt: '11 min ago',
  },
];

export const COMPLETED_TASKS: CompletedTask[] = [
  {
    id: 'c1',
    title: 'Cleared the support inbox',
    finishedAt: '20 min ago',
    outcome: 'success',
  },
  {
    id: 'c2',
    title: 'Rescheduled 3 conflicting meetings',
    finishedAt: '1h ago',
    outcome: 'success',
  },
  {
    id: 'c3',
    title: 'Synced contacts from the CRM',
    finishedAt: '2h ago',
    outcome: 'failed',
  },
  {
    id: 'c4',
    title: 'Generated the weekly standup notes',
    finishedAt: 'Yesterday',
    outcome: 'success',
  },
];

export const WORKFLOWS: Workflow[] = [
  {
    id: 'w1',
    name: 'Morning briefing',
    schedule: 'Every day · 8:00 AM',
    nextRun: 'Tomorrow, 8:00 AM',
    status: 'active',
    lastRun: 'success',
  },
  {
    id: 'w2',
    name: 'Inbox triage',
    schedule: 'Every 2 hours',
    nextRun: 'in 47 min',
    status: 'active',
    lastRun: 'success',
  },
  {
    id: 'w3',
    name: 'Weekly investor update',
    schedule: 'Fridays · 5:00 PM',
    nextRun: 'Fri, 5:00 PM',
    status: 'paused',
    lastRun: 'never',
  },
];
