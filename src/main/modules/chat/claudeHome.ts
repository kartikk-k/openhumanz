/**
 * Where Claude Code keeps its session transcripts on disk, and how a working
 * directory maps to that location.
 *
 * Claude Code writes one JSONL file per session under
 *   <claude-home>/projects/<encoded-cwd>/<sessionId>.jsonl
 * where `<encoded-cwd>` is the absolute cwd with every `/` and `.` replaced by
 * `-`. `<claude-home>` is `$CLAUDE_CONFIG_DIR` if set, else `~/.claude`.
 *
 * We point the Chat feature's cwd at `<workspace>/claude-chats`, so all of its
 * sessions land in one encoded folder that holds nothing else — the chat
 * history, isolated from the user's real project sessions.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseTranscript,
  type SubagentTranscript,
} from '../../../shared/claudeTranscript.fold';

/** The root of Claude Code's on-disk state (`~/.claude` unless overridden). */
export function claudeHome(): string {
  const override = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.claude');
}

/**
 * Encode an absolute cwd the way Claude Code names its project folders: every
 * `/` and `.` becomes `-`. So `/Users/x/.assistant/claude-chats` becomes
 * `-Users-x--assistant-claude-chats`.
 */
export function encodeProjectDir(absoluteCwd: string): string {
  return path.resolve(absoluteCwd).replace(/[/.]/g, '-');
}

/** The `<claude-home>/projects/<encoded>` directory for a given cwd. */
export function projectTranscriptDir(absoluteCwd: string): string {
  return path.join(claudeHome(), 'projects', encodeProjectDir(absoluteCwd));
}

/** The transcript file for one session id in a given cwd. */
export function sessionTranscriptFile(
  absoluteCwd: string,
  sessionId: string,
): string {
  return path.join(projectTranscriptDir(absoluteCwd), `${sessionId}.jsonl`);
}

export interface SessionFileInfo {
  sessionId: string;
  file: string;
  /** Last-modified time in epoch ms — newest is the "current" session. */
  modifiedMs: number;
  sizeBytes: number;
}

/**
 * List every session transcript for a cwd, newest first. Returns [] if the
 * project folder does not exist yet (no chats started).
 */
export async function listSessions(
  absoluteCwd: string,
): Promise<SessionFileInfo[]> {
  const dir = projectTranscriptDir(absoluteCwd);
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }

  const infos = await Promise.all(
    entries
      .filter((name) => name.endsWith('.jsonl'))
      .map(async (name): Promise<SessionFileInfo | null> => {
        const file = path.join(dir, name);
        try {
          const stat = await fsp.stat(file);
          if (!stat.isFile()) return null;
          return {
            sessionId: name.replace(/\.jsonl$/, ''),
            file,
            modifiedMs: stat.mtimeMs,
            sizeBytes: stat.size,
          };
        } catch {
          return null;
        }
      }),
  );

  return infos
    .filter((info): info is SessionFileInfo => info !== null)
    .sort((a, b) => b.modifiedMs - a.modifiedMs);
}

/** The most recently modified session for a cwd, or null if there are none. */
export async function latestSession(
  absoluteCwd: string,
): Promise<SessionFileInfo | null> {
  const sessions = await listSessions(absoluteCwd);
  return sessions[0] ?? null;
}

/** Read a session transcript's raw JSONL text, or '' if it does not exist. */
export async function readSessionText(file: string): Promise<string> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Read a session's subagent transcripts.
 *
 * Modern Claude Code writes each spawned subagent to its own file under
 * `<projectDir>/<sessionId>/subagents/agent-*.jsonl`, with a sibling
 * `agent-*.meta.json` carrying `{ agentType, description, toolUseId }`. The
 * `toolUseId` links the subagent back to the parent Task `tool_use` in the main
 * transcript — that is how the UI nests a subagent under the call that spawned
 * it. Returns [] when there is no subagents directory.
 */
export async function readSubagents(
  absoluteCwd: string,
  sessionId: string,
): Promise<SubagentTranscript[]> {
  const dir = path.join(
    projectTranscriptDir(absoluteCwd),
    sessionId,
    'subagents',
  );
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }

  const files = entries.filter(
    (name) => name.endsWith('.jsonl') && name.startsWith('agent-'),
  );

  const subs = await Promise.all(
    files.map(async (name): Promise<SubagentTranscript | null> => {
      try {
        const text = await fsp.readFile(path.join(dir, name), 'utf8');
        const records = parseTranscript(text);
        let toolUseId: string | undefined;
        let label: string | undefined;
        try {
          const metaName = name.replace(/\.jsonl$/, '.meta.json');
          const meta = JSON.parse(
            await fsp.readFile(path.join(dir, metaName), 'utf8'),
          ) as {
            toolUseId?: string;
            agentType?: string;
            description?: string;
          };
          toolUseId = meta.toolUseId;
          label = meta.agentType ?? meta.description;
        } catch {
          /* no meta — fall back to file-order linkage */
        }
        return { toolUseId, name: label, records };
      } catch {
        return null;
      }
    }),
  );

  return subs.filter((s): s is SubagentTranscript => s !== null);
}

/** Does a session transcript file exist yet? */
export function sessionFileExists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
