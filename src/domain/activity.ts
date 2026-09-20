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
