/**
 * Classification: deciding *what* a tool call is asking to do.
 *
 * The gate never matches a grant against a tool name alone (see the long note
 * in `gate.ts`). It matches against a **capability**, and a capability is
 * produced here: `(toolName, args) -> { action?, discriminator }`.
 *
 * For a normal, narrow tool (`calendar_delete_event`) the tool name *is* the
 * capability and the classifier returns nothing — the discriminator is `{}`.
 *
 * For a **generic dispatcher** — one tool that performs many different actions,
 * `calendar({ action: 'read' | 'delete', ... })` — the tool name is a lie about
 * what the call does, and a grant keyed on it would let an `always` on "read
 * calendar" silently authorise "delete calendar event". ARCHITECTURE.md calls
 * this out; {@link dispatcherClassifier} is the hook for it. No such tool
 * exists yet, and the hook exists so that adding one is a registration rather
 * than a change to the gate.
 */
import type { JsonObject } from '../../../shared/common';

/** What the gate learns about one call. Every field is optional. */
export interface ApprovalClassification {
  /**
   * The action actually being requested, when the tool name does not say it.
   * Becomes part of the capability fingerprint, so grants never cross actions.
   */
  action?: string;
  /**
   * Extra argument fields that narrow the capability further. Include a field
   * here when `always` should mean "always, for this value" rather than
   * "always, for anything" — e.g. `{ recipient }` on a send-mail tool turns an
   * `always` grant into "always email ana@example.com".
   *
   * Everything in here is hashed into the fingerprint, so a grant is exactly as
   * wide as this object is narrow.
   */
  discriminator?: JsonObject;
  /**
   * Per-call override of the tool's `sideEffecting` flag. A dispatcher's read
   * actions can pass straight through while its write actions are gated.
   */
  sideEffecting?: boolean;
  /** Plain-language heading for the approval card. */
  title?: string;
  /** One line of plain language under the heading. */
  summary?: string;
}

export type ApprovalClassifier = (call: {
  toolName: string;
  args: JsonObject;
}) => ApprovalClassification | undefined | void;

export interface ClassifierRegistry {
  /** Register a classifier for one tool. Replaces any previous one. */
  register(toolName: string, classifier: ApprovalClassifier): void;
  /** Fallback applied to every tool without its own classifier. */
  setDefault(classifier: ApprovalClassifier | null): void;
  classify(toolName: string, args: JsonObject): ApprovalClassification;
  clear(): void;
}

export function createClassifierRegistry(): ClassifierRegistry {
  const byTool = new Map<string, ApprovalClassifier>();
  let fallback: ApprovalClassifier | null = null;

  return {
    register(toolName, classifier) {
      byTool.set(toolName, classifier);
    },
    setDefault(classifier) {
      fallback = classifier;
    },
    clear() {
      byTool.clear();
      fallback = null;
    },
    classify(toolName, args) {
      const classifier = byTool.get(toolName) ?? fallback;
      if (!classifier) return {};
      try {
        return classifier({ toolName, args }) ?? {};
      } catch {
        // A throwing classifier must not become a way past the gate. An
        // unclassified call falls back to the tool-name capability, which is
        // the conservative answer for a narrow tool and is combined with a
        // fail-closed `sideEffecting` default in the gate.
        return {};
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Generic dispatchers                                                 */
/* ------------------------------------------------------------------ */

export interface DispatcherClassifierOptions {
  /** Argument field naming the action. Default `action`. */
  actionKey?: string;
  /**
   * Actions that only read. Everything not listed is treated as
   * side-effecting — an unknown action must never be assumed harmless.
   */
  readOnlyActions?: readonly string[];
  /** Argument fields folded into the capability, per action or for all. */
  discriminatorKeys?: readonly string[] | Record<string, readonly string[]>;
  /** Renders the card heading. */
  title?(action: string, args: JsonObject): string;
  summarize?(action: string, args: JsonObject): string;
}

/**
 * Build a classifier for a tool that dispatches on an argument.
 *
 * ```ts
 * gate.registerClassifier('calendar', dispatcherClassifier({
 *   actionKey: 'action',
 *   readOnlyActions: ['read', 'list'],
 *   discriminatorKeys: { delete: ['calendarId'] },
 * }));
 * ```
 *
 * An `always` grant taken on `calendar{action:'read'}` then covers only
 * `action: 'read'`; `action: 'delete'` produces a different fingerprint and
 * therefore a fresh approval.
 */
export function dispatcherClassifier(
  options: DispatcherClassifierOptions = {},
): ApprovalClassifier {
  const {
    actionKey = 'action',
    readOnlyActions = [],
    discriminatorKeys = [],
    title,
    summarize,
  } = options;
  const readOnly = new Set(readOnlyActions);

  return ({ args }) => {
    const raw = args[actionKey];
    // An absent or non-string action means we cannot tell what is being asked
    // for. `unknown` is its own capability and is side-effecting.
    const action = typeof raw === 'string' && raw ? raw : 'unknown';

    const keys: readonly string[] = Array.isArray(discriminatorKeys)
      ? discriminatorKeys
      : ((discriminatorKeys as Record<string, readonly string[]>)[action] ??
        []);

    const discriminator: JsonObject = {};
    for (const key of keys) {
      if (args[key] !== undefined) discriminator[key] = args[key];
    }

    return {
      action,
      discriminator,
      sideEffecting: !readOnly.has(action),
      title: title?.(action, args),
      summary: summarize?.(action, args),
    };
  };
}
