/**
 * ActivityChip — a small, humanized "what's happening" indicator, top-right
 * (near the Upcoming card). While the assistant runs tool calls in the
 * background, this shows ONE friendly line ("Sending message…", "Checking
 * Slack…") with a spinner, then a brief ✓, then fades. No raw tool slugs — the
 * home surface hides the machinery; this is just a gentle sign of life.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import type {
  ChatBlock,
  ChatToolCall,
} from '../../../../shared/claudeTranscript.fold';

interface Phrase {
  /** present-tense, shown while the tool runs: "Reading Slack channels" */
  active: string;
  /** past-tense, shown on the ✓: "Slack message sent" */
  done: string;
}

/** Friendly app name from the Composio app slug (or the mcp tool name). */
function appName(hay: string): string | null {
  if (/slack/.test(hay)) return 'Slack';
  if (/gmail|\bmail\b|email/.test(hay)) return 'email';
  if (/(google[_-]?)?calendar|gcal/.test(hay)) return 'calendar';
  if (/notion/.test(hay)) return 'Notion';
  if (/github/.test(hay)) return 'GitHub';
  if (/linear/.test(hay)) return 'Linear';
  if (/drive|docs|sheets/.test(hay)) return 'Google Drive';
  return null;
}

/** What kind of thing the tool touches, for a specific noun. */
function noun(hay: string): string {
  if (/messages|chats|dms|conversations/.test(hay)) return 'messages';
  if (/message|chat|dm/.test(hay)) return 'message';
  if (/channel/.test(hay)) return 'channels';
  if (/event|calendar/.test(hay)) return 'events';
  if (/email|mail|thread/.test(hay)) return 'email';
  if (/file|doc|sheet/.test(hay)) return 'files';
  if (/contact|people|user/.test(hay)) return 'contacts';
  return 'that';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A Task tool carries the useful user-facing name in its description rather
 * than in the tool slug. Keep that name short and turn common imperative
 * descriptions into the same present/past phrasing as regular tools.
 */
function taskPhrase(description: unknown): Phrase | null {
  if (typeof description !== 'string') return null;
  let text = description.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  text = text
    .replace(/^(please|can you|could you|i need you to|you should)\s+/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  if (!text) return null;

  // A model-generated description can be very long; this is a compact status
  // indicator, not a second prompt or transcript view.
  if (text.length > 72) text = `${text.slice(0, 69).trimEnd()}…`;

  const leading = text.match(
    /^(read|reading|list|listing|search|searching|find|finding|fetch|fetching|check|checking|look up|looking up|review|reviewing|inspect|inspecting|send|sending|post|posting|create|creating|update|updating|delete|deleting|remove|removing|schedule|scheduling)\b\s*(.*)$/i,
  );
  if (!leading)
    return { active: `Working on ${text}`, done: `Finished ${text}` };

  const verb = leading[1].toLowerCase();
  const object = leading[2].trim();
  const progressive: Record<string, string> = {
    read: 'Reading',
    reading: 'Reading',
    list: 'Listing',
    listing: 'Listing',
    search: 'Searching',
    searching: 'Searching',
    find: 'Finding',
    finding: 'Finding',
    fetch: 'Fetching',
    fetching: 'Fetching',
    check: 'Checking',
    checking: 'Checking',
    'look up': 'Looking up',
    'looking up': 'Looking up',
    review: 'Reviewing',
    reviewing: 'Reviewing',
    inspect: 'Inspecting',
    inspecting: 'Inspecting',
    send: 'Sending',
    sending: 'Sending',
    post: 'Posting',
    posting: 'Posting',
    create: 'Creating',
    creating: 'Creating',
    update: 'Updating',
    updating: 'Updating',
    delete: 'Deleting',
    deleting: 'Deleting',
    remove: 'Removing',
    removing: 'Removing',
    schedule: 'Scheduling',
    scheduling: 'Scheduling',
  };
  const past: Record<string, string> = {
    read: 'Read',
    reading: 'Read',
    list: 'Listed',
    listing: 'Listed',
    search: 'Searched',
    searching: 'Searched',
    find: 'Found',
    finding: 'Found',
    fetch: 'Fetched',
    fetching: 'Fetched',
    check: 'Checked',
    checking: 'Checked',
    'look up': 'Looked up',
    'looking up': 'Looked up',
    review: 'Reviewed',
    reviewing: 'Reviewed',
    inspect: 'Inspected',
    inspecting: 'Inspected',
    send: 'Sent',
    sending: 'Sent',
    post: 'Posted',
    posting: 'Posted',
    create: 'Created',
    creating: 'Created',
    update: 'Updated',
    updating: 'Updated',
    delete: 'Deleted',
    deleting: 'Deleted',
    remove: 'Removed',
    removing: 'Removed',
    schedule: 'Scheduled',
    scheduling: 'Scheduled',
  };
  return {
    active: `${progressive[verb] ?? 'Working on'}${object ? ` ${object}` : ''}`,
    done: `${past[verb] ?? 'Finished'}${object ? ` ${object}` : ''}`,
  };
}

/**
 * Turn a raw tool call into specific present/past phrases from the app + verb.
 * Composio calls carry `input.app` (e.g. "slack") and `input.tool` (e.g.
 * SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL) — the most reliable signal.
 */
function humanize(call: ChatToolCall): Phrase {
  const rawInput = record(call.input);
  // Support both direct calls and a router payload where the useful fields are
  // nested under `arguments`.
  const nestedInput = record(rawInput.arguments);
  const input =
    rawInput.app || rawInput.tool || rawInput.toolSlug ? rawInput : nestedInput;
  const app = String(input.app ?? '').toLowerCase();
  const tool = String(input.tool ?? input.toolSlug ?? '').toLowerCase();
  const hay = `${call.name.toLowerCase()} ${app} ${tool}`;
  const svc = appName(hay);

  // Task/subagent calls have no meaningful action slug. Their description is
  // precisely the task name the user needs to see in the home status chip.
  if (/(^|[^a-z])(task|agent)([^a-z]|$)/i.test(call.name)) {
    const task = taskPhrase(
      rawInput.description ?? rawInput.task ?? rawInput.name,
    );
    if (task) return task;
  }

  // send / post / create / reply → an action
  if (
    /(^|[^a-z])(send|sends|post|posts|create|creates|write|writes|reply|repl(?:y|ies)|share|shares|schedule)([^a-z]|$)/.test(
      hay,
    )
  ) {
    if (svc === 'Slack')
      return { active: 'Sending Slack message', done: 'Slack message sent' };
    if (svc === 'email') return { active: 'Sending email', done: 'Email sent' };
    if (svc === 'calendar')
      return { active: 'Adding to your calendar', done: 'Added to calendar' };
    return svc
      ? { active: `Updating ${svc}`, done: `${svc} updated` }
      : { active: 'Sending', done: 'Sent' };
  }

  // list / search / get / read / fetch → a read
  if (
    /(^|[^a-z])(list|lists|search|searches|find|finds|fetch|fetches|get|gets|read|reads|query|queries|history|conversations)([^a-z]|$)/.test(
      hay,
    )
  ) {
    const what = noun(hay);
    if (svc)
      return {
        active: `Reading ${svc} ${what}`,
        done: `Read ${svc} ${what}`,
      };
    return { active: `Looking up ${what}`, done: `Found ${what}` };
  }

  if (/memory/.test(hay)) {
    return /search|list|recall|get/.test(hay)
      ? { active: 'Recalling what I know', done: 'Recalled' }
      : { active: 'Remembering that', done: 'Remembered' };
  }
  if (/schedule/.test(hay))
    return { active: 'Setting that up', done: 'Scheduled' };
  if (/toolsearch|composio_(connected_apps|app_tools)/.test(hay))
    return { active: 'Finding the right tool', done: 'Ready' };

  return { active: 'Working on it', done: 'Done' };
}

/** The newest still-running tool call, if any. */
function activeCall(blocks: ChatBlock[]): ChatToolCall | null {
  let latest: ChatToolCall | null = null;
  blocks.forEach((b) => {
    if (b.kind === 'tool' && !b.call.result) latest = b.call;
  });
  return latest;
}

/** The most recent COMPLETED tool call (for the ✓ 'done' phrase). */
function lastCompleted(blocks: ChatBlock[]): ChatToolCall | null {
  let latest: ChatToolCall | null = null;
  blocks.forEach((b) => {
    if (b.kind === 'tool' && b.call.result) latest = b.call;
  });
  return latest;
}

export function ActivityChip({
  blocks,
  running,
}: {
  blocks: ChatBlock[];
  /** true while the turn is still streaming. */
  running: boolean;
}) {
  const active = running ? activeCall(blocks) : null;
  const finished = lastCompleted(blocks);
  // { text, done } — done=false shows the spinner + present tense; done=true
  // shows the ✓ + the completed action's past-tense phrase, then fades.
  const [chip, setChip] = useState<{ text: string; done: boolean } | null>(
    null,
  );
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  // Signatures that actually change per distinct tool call. Tool-call ids can be
  // empty from the stream, so we key on the humanized phrase itself — when the
  // active tool changes, its phrase changes and the effect re-runs.
  const activePhrase = active ? humanize(active).active : '';
  const donePhrase = finished ? humanize(finished).done : '';

  useEffect(() => {
    if (activePhrase) {
      // a tool is running — show its specific present-tense phrase.
      clearTimeout(hideTimer.current);
      setChip({ text: activePhrase, done: false });
      return;
    }
    // nothing running: flash the last completed action's past-tense phrase with
    // a ✓, then fade out.
    if (donePhrase) {
      setChip({ text: donePhrase, done: true });
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setChip(null), 1600);
    } else if (!running) {
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setChip(null), 1200);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePhrase, donePhrase, running]);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  if (!chip) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-16 z-20">
      <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs text-white/70 backdrop-blur-xl">
        {chip.done ? (
          <Check size={12} className="text-emerald-400" aria-hidden />
        ) : (
          <Loader2
            size={12}
            className="animate-spin text-white/50"
            aria-hidden
          />
        )}
        <span>{chip.text}</span>
      </div>
    </div>
  );
}

export default ActivityChip;
