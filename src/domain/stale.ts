import type { SwExpense, SwFriend } from '../splitwise/types.js';
import { type Minor, toMinor } from './money.js';

export interface StaleBalance {
  counterpartyId: number;
  counterpartyName: string;
  currency: string;
  /** Positive: they owe me. Negative: I owe them. */
  amount: Minor;
  /** Days since the most recent shared expense or payment. */
  ageDays: number;
  lastActivity: string;
}

function fullName(f: { first_name: string; last_name: string | null }): string {
  return [f.first_name, f.last_name].filter(Boolean).join(' ');
}

/**
 * Find balances that have been open longer than `olderThanDays`.
 *
 * `friends` gives the current net balance per person (from /get_friends).
 * `expenses` gives the activity dates. A balance is stale when it is non-zero
 * and the most recent shared expense or payment is older than the threshold.
 */
export function staleBalances(
  meId: number,
  friends: SwFriend[],
  expenses: SwExpense[],
  olderThanDays: number,
  now: Date = new Date(),
): StaleBalance[] {
  const lastActivity = new Map<number, string>();
  for (const e of expenses) {
    if (e.deleted_at) continue;
    if (!e.users.some((u) => u.user_id === meId)) continue;
    for (const u of e.users) {
      if (u.user_id === meId) continue;
      const prev = lastActivity.get(u.user_id);
      if (!prev || e.date > prev) lastActivity.set(u.user_id, e.date);
    }
  }

  const out: StaleBalance[] = [];
  for (const f of friends) {
    for (const b of f.balance) {
      const amount = toMinor(b.amount);
      if (amount === 0) continue;
      const last = lastActivity.get(f.id) ?? f.updated_at;
      const ageDays = Math.floor((now.getTime() - new Date(last).getTime()) / 86_400_000);
      if (ageDays < olderThanDays) continue;
      out.push({
        counterpartyId: f.id,
        counterpartyName: fullName(f),
        currency: b.currency_code,
        amount,
        ageDays,
        lastActivity: last,
      });
    }
  }
  return out.sort((a, b) => b.ageDays - a.ageDays);
}
