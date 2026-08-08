/**
 * What the memory layout hands down to its child routes.
 *
 * The layout owns the two queries every pane needs — `memory:list` and
 * `memory:status` — so a child route never refetches the vault just to learn
 * where it lives. Passed through the router's `<Outlet context>` rather than a
 * new React context, because the layout route is the only provider there will
 * ever be.
 */
import type { MemoryDoc } from '../../../shared/memory';
import type { IpcError } from '../../lib/ipc';

export interface MemoryOutletContext {
  /** Absolute path of the vault directory, from `memory:status`. */
  vaultPath: string;
  /** Every indexed document, as returned by `memory:list`. */
  docs: readonly MemoryDoc[];
  /**
   * Non-null when `memory:list` failed. Panes must check it before saying the
   * vault is empty — "no documents" and "could not ask" are different states
   * and conflating them is how a broken bridge reads as data loss.
   */
  listError: IpcError | null;
  /** Re-run the vault queries. */
  onRetry: () => void;
  /** The live search box contents — child panes mark these terms in prose. */
  searchQuery: string;
  /** Open the write dialog on an existing note. */
  onEdit: (path: string, content: string) => void;
  /** Open the write dialog on a new note. */
  onCreate: () => void;
  /** Select another note in the vault. */
  onOpenDoc: (path: string) => void;
}
