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

export interface MemoryOutletContext {
  /** Absolute path of the vault directory, from `memory:status`. */
  vaultPath: string;
  /** Every indexed document, as returned by `memory:list`. */
  docs: readonly MemoryDoc[];
  /** The live search box contents — child panes mark these terms in prose. */
  searchQuery: string;
  /** Open the write dialog on an existing note. */
  onEdit: (path: string, content: string) => void;
  /** Open the write dialog on a new note. */
  onCreate: () => void;
  /** Select another note in the vault. */
  onOpenDoc: (path: string) => void;
}
