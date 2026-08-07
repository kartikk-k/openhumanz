/**
 * The board, rendered as markdown.
 *
 * One renderer, used by the UI and by the agent, so a card the user is looking
 * at and a card in a transcript are the same words in the same order. It is also
 * why the tool results stay cheap: markdown of a board costs a fraction of the
 * JSON of the same board, and the agent pays for every byte.
 *
 * Two densities:
 *  - {@link renderBoard} — one line per card, grouped by status. For lists.
 *  - {@link renderCard} — the whole card. For `get` and for the approval card.
 */
import {
  CARD_STATUS_LABELS,
  CARD_STATUS_ORDER,
  CardStatus,
  TaskCard,
} from './schema';

/** Board-line description budget. Long prose belongs in `get`. */
const SUMMARY_CHARS = 120;

function clip(value: string, max = SUMMARY_CHARS): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** `2/5` for a checklist, or `''` when there is nothing to count. */
function progress(done: number, total: number): string {
  return total === 0 ? '' : `${done}/${total}`;
}

function planProgress(card: TaskCard): string {
  return progress(
    card.plan.filter((step) => step.done).length,
    card.plan.length,
  );
}

function criteriaProgress(card: TaskCard): string {
  return progress(
    card.acceptanceCriteria.filter((criterion) => criterion.met).length,
    card.acceptanceCriteria.length,
  );
}

/** Human name for a board. */
export function boardTitle(board: string, conversationId?: string): string {
  return board === 'conversation'
    ? `conversation ${conversationId ?? '?'}`
    : 'personal';
}

/**
 * One card as a board line: id, title, and only the facts that decide what to
 * do next — priority when it is not normal, assignee, progress, blocker.
 */
export function renderBoardLine(card: TaskCard): string {
  const bits: string[] = [];
  if (card.priority !== 'normal') bits.push(card.priority);
  if (card.assignedAgent) bits.push(`@${card.assignedAgent}`);
  const plan = planProgress(card);
  if (plan) bits.push(`plan ${plan}`);
  const criteria = criteriaProgress(card);
  if (criteria) bits.push(`criteria ${criteria}`);
  if (card.dueAt) bits.push(`due ${card.dueAt.slice(0, 10)}`);

  const head = `- \`${card.id}\` **${clip(card.title, 80)}**${
    bits.length > 0 ? ` · ${bits.join(' · ')}` : ''
  }`;

  if (card.cardStatus === 'blocked' && card.blockerReason) {
    return `${head}\n  Blocked: ${clip(card.blockerReason)}`;
  }
  const detail = card.objective || card.description;
  return detail ? `${head}\n  ${clip(detail)}` : head;
}

export interface RenderBoardOptions {
  board: string;
  conversationId?: string;
  /** Total matching the query, which may exceed `cards.length`. */
  total?: number;
}

/**
 * A whole board. Empty sections are omitted — a board with nothing blocked
 * should not spend a heading saying so.
 */
export function renderBoard(
  cards: TaskCard[],
  options: RenderBoardOptions,
): string {
  const title = boardTitle(options.board, options.conversationId);
  const shown = cards.length;
  const total = options.total ?? shown;

  if (shown === 0) {
    return `# Task board — ${title}\n\nNo tasks.`;
  }

  const grouped = new Map<CardStatus, TaskCard[]>();
  for (const card of cards) {
    const bucket = grouped.get(card.cardStatus);
    if (bucket) bucket.push(card);
    else grouped.set(card.cardStatus, [card]);
  }

  const lines: string[] = [`# Task board — ${title}`, ''];
  lines.push(
    total > shown
      ? `${shown} of ${total} tasks shown.`
      : `${total} task${total === 1 ? '' : 's'}.`,
  );

  for (const status of CARD_STATUS_ORDER) {
    const bucket = grouped.get(status);
    if (!bucket || bucket.length === 0) continue;
    lines.push('', `## ${CARD_STATUS_LABELS[status]} (${bucket.length})`);
    for (const card of bucket) lines.push(renderBoardLine(card));
  }

  return `${lines.join('\n')}\n`;
}

function section(heading: string, body: string): string[] {
  return body.trim() ? ['', `**${heading}**`, body.trim()] : [];
}

/** The full card. This is what `tasks:get` and `tasks_get` return. */
export function renderCard(card: TaskCard): string {
  const meta: string[] = [
    CARD_STATUS_LABELS[card.cardStatus].toLowerCase(),
    `${card.priority} priority`,
    `${boardTitle(card.board, card.conversationId)} board`,
  ];
  if (card.assignedAgent) meta.push(`@${card.assignedAgent}`);
  meta.push(`approval: ${card.approvalMode}`);
  if (card.dueAt) meta.push(`due ${card.dueAt.slice(0, 10)}`);
  if (card.goalId) meta.push(`goal ${card.goalId}`);

  const lines: string[] = [
    `# ${card.title}`,
    '',
    `\`${card.id}\` · ${meta.join(' · ')}`,
  ];

  lines.push(...section('Objective', card.objective));
  lines.push(...section('Desired outcome', card.desiredOutcome));
  lines.push(...section('Description', card.description));

  if (card.cardStatus === 'blocked' || card.blockerReason) {
    lines.push(
      ...section('Blocked', card.blockerReason || 'No reason recorded.'),
    );
  }

  if (card.plan.length > 0) {
    lines.push('', `**Plan** (${planProgress(card)})`);
    card.plan.forEach((step, index) => {
      lines.push(`${index + 1}. [${step.done ? 'x' : ' '}] ${step.text}`);
    });
  }

  if (card.acceptanceCriteria.length > 0) {
    lines.push('', `**Acceptance criteria** (${criteriaProgress(card)})`);
    for (const criterion of card.acceptanceCriteria) {
      lines.push(`- [${criterion.met ? 'x' : ' '}] ${criterion.text}`);
    }
  }

  if (card.evidence.length > 0) {
    lines.push('', '**Evidence**');
    for (const item of card.evidence) {
      lines.push(
        item.ref ? `- ${item.label} — ${item.ref}` : `- ${item.label}`,
      );
    }
  }

  lines.push(...section('Notes', card.notes));

  if (card.tags.length > 0) {
    lines.push('', `Tags: ${card.tags.map((tag) => `#${tag}`).join(' ')}`);
  }

  return `${lines.join('\n')}\n`;
}
