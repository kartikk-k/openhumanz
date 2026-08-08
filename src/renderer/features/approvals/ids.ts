/**
 * Local row ids for the in-window decision log.
 *
 * Not `crypto.randomUUID`: this file is imported by the SSR render check, which
 * runs without a DOM, and a missing `crypto` there would be a crash in a place
 * that has nothing to do with what is being checked. A counter is enough — these
 * ids never leave the renderer and never reach the database.
 */
let counter = 0;

export function nanoIdish(): string {
  counter += 1;
  return `dec-${Date.now().toString(36)}-${counter}`;
}
