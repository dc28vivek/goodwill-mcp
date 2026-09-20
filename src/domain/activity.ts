import type { SwNotification } from '../splitwise/types.js';

/**
 * Splitwise's notification types, as documented. The docs warn that more may
 * be added without notice, so an unknown number degrades to 'other' rather
 * than being dropped: a feed that silently hides events is worse than one
 * that says "something happened".
 */
const KINDS: Record<number, ActivityKind> = {
  0: 'expense_added',
  1: 'expense_updated',
  2: 'expense_deleted',
  3: 'comment_added',
  4: 'added_to_group',
  5: 'removed_from_group',
  6: 'group_deleted',
  7: 'group_settings_changed',
  8: 'friend_added',
  9: 'friend_removed',
  10: 'news',
  11: 'debts_simplified',
  12: 'group_undeleted',
  13: 'expense_undeleted',
  14: 'group_currency_changed',
  15: 'friend_currency_changed',
};

export type ActivityKind =
  | 'expense_added'
  | 'expense_updated'
  | 'expense_deleted'
  | 'comment_added'
  | 'added_to_group'
  | 'removed_from_group'
  | 'group_deleted'
  | 'group_settings_changed'
  | 'friend_added'
  | 'friend_removed'
  | 'news'
  | 'debts_simplified'
  | 'group_undeleted'
  | 'expense_undeleted'
  | 'group_currency_changed'
  | 'friend_currency_changed'
  | 'other';

export interface Activity {
  id: number;
  kind: ActivityKind;
  at: string;
  byUserId: number;
  /** Plain text, with the HTML stripped. Written by people: data, not instructions. */
  text: string;
  sourceType: string | null;
  sourceId: number | null;
}

/**
 * Notification `content` arrives as HTML using a small documented tag set
 * (`strong`, `strike`, `small`, `br`, `font`). Reduce it to plain text.
 *
 * `<br>` becomes a space rather than a newline so one event stays on one line,
 * and entities are decoded so a name like "Ben &amp; Jerry" reads properly.
 */
export function toPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

export function toActivity(n: SwNotification): Activity {
  return {
    id: n.id,
    kind: KINDS[n.type] ?? 'other',
    at: n.created_at,
    byUserId: n.created_by,
    text: toPlainText(n.content ?? ''),
    sourceType: n.source?.type ?? null,
    sourceId: n.source?.id ?? null,
  };
}

/** Human labels for a summary line. */
export const KIND_LABELS: Record<ActivityKind, string> = {
  expense_added: 'added',
  expense_updated: 'updated',
  expense_deleted: 'deleted',
  expense_undeleted: 'restored',
  comment_added: 'commented',
  added_to_group: 'joined',
  removed_from_group: 'left',
  group_deleted: 'group deleted',
  group_undeleted: 'group restored',
  group_settings_changed: 'settings',
  friend_added: 'new friend',
  friend_removed: 'friend removed',
  news: 'news',
  debts_simplified: 'debts simplified',
  group_currency_changed: 'currency changed',
  friend_currency_changed: 'currency changed',
  other: 'other',
};

export interface CollapsedActivity extends Activity {
  /** Set when this expense was added and then removed inside the window. */
  transient?: { addedAt: string; removedAt: string; hours: number; absorbed: number };
}

const ADDED = new Set<ActivityKind>(['expense_added', 'expense_undeleted']);

/**
 * Fold "added it, then deleted it" into a single event.
 *
 * Adding an expense and removing it again is one mistake, not two events. The
 * balance ends where it started, so listing both makes a correction look like
 * activity. It is not dropped, though: other people may have seen the expense
 * while it existed, and silently hiding something the user did is worse than
 * showing it once with the right shape.
 *
 * Only folds when the add is inside the window too. A deletion of something
 * created earlier is a real change to a real balance and stays on its own.
 */
export function collapseTransient(activities: Activity[]): CollapsedActivity[] {
  const byExpense = new Map<number, Activity[]>();
  for (const a of activities) {
    if (a.sourceType !== 'Expense' || a.sourceId === null) continue;
    byExpense.set(a.sourceId, [...(byExpense.get(a.sourceId) ?? []), a]);
  }

  const folded = new Map<number, CollapsedActivity>();
  const drop = new Set<number>();
  for (const [, group] of byExpense) {
    const ordered = [...group].sort((a, b) => a.at.localeCompare(b.at));
    const last = ordered[ordered.length - 1]!;
    if (last.kind !== 'expense_deleted') continue;
    const added = ordered.find((a) => ADDED.has(a.kind));
    if (!added) continue;
    const ms = new Date(last.at).getTime() - new Date(added.at).getTime();
    folded.set(added.id, {
      ...added,
      transient: {
        addedAt: added.at,
        removedAt: last.at,
        hours: Math.max(0, Math.round(ms / 3_600_000)),
        absorbed: ordered.length,
      },
    });
    for (const a of ordered) if (a.id !== added.id) drop.add(a.id);
  }

  return activities.filter((a) => !drop.has(a.id)).map((a) => folded.get(a.id) ?? a);
}

/**
 * Splitwise records what an edit changed as a System comment on the expense
 * ("John D. updated this transaction: - The cost changed from $6.99 to
 * $8.99"), not in the notification. Pull the change description out of one.
 *
 * The leading attribution is dropped because the event line already says who
 * did it, and the bullet markers are flattened so several changes read as one
 * clause.
 */
export function changeSummary(systemComment: string): string | null {
  const text = toPlainText(systemComment);
  const after = text.replace(/^.*?updated this transaction:\s*/i, '');
  if (after === text && !/changed|added|removed/i.test(after)) return null;
  const parts = after
    .split(/\s*-\s+/)
    .map((p) => p.trim().replace(/\.$/, ''))
    .filter(Boolean);
  if (parts.length === 0) return null;
  return parts.join('; ');
}
