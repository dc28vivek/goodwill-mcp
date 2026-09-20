import type { SwExpense } from '../splitwise/types.js';
import { type Minor, toMinor } from './money.js';

export interface Contribution {
  expenseId: number;
  description: string;
  date: string;
  currency: string;
  /** Positive: the counterparty owes `me` from this expense. Negative: I owe them. */
  amount: Minor;
  /** What the whole expense cost, so a share can be read against it. */
  total: Minor;
  kind: 'expense' | 'payment';
}

/**
 * Where to start explaining from.
 *
 * - `last_settled`: after the balance last stood at exactly zero. Nothing is
 *   carried forward, because the excluded history nets out.
 * - `last_payment`: after the most recent payment of any size. A partial
 *   payment leaves a balance behind, which is carried forward.
 * - `all`: the whole history.
 * - `{ after }`: everything dated after this ISO date.
 */
export type SinceMode = 'last_settled' | 'last_payment' | 'all' | { after: string };

export interface BalanceExplanation {
  meId: number;
  counterpartyId: number;
  currency: string;
  /** Positive: they owe me. Negative: I owe them. */
  net: Minor;
  /**
   * A statement rather than a net, because "why do I owe this much?" is really
   * three questions: what was I charged for, what have I already settled, and
   * what is left. `charged` counts expenses only; `settled` counts payments
   * only. Both are signed the same way as `net`, and `net = charged + settled`.
   */
  charged: Minor;
  settled: Minor;
  /**
   * What was already owed when the window opens. Zero for `last_settled` by
   * definition; non-zero when a payment or a date cuts mid-history. Always
   * `net = broughtForward + charged + settled`.
   */
  broughtForward: Minor;
  expenseCount: number;
  paymentCount: number;
  /**
   * The date the window opens after, if anything was excluded. Everything on
   * or before this is left out of the figures above.
   */
  settledOn: string | null;
  /** Which rule chose the window. */
  since: 'last_settled' | 'last_payment' | 'all' | 'date';
  /** How many closed items were left out. */
  closedCount: number;
  contributions: Contribution[];
}

/**
 * Explain the balance between two people from the raw expenses they share.
 *
 * Per expense, each person's net is paid_share minus owed_share. Between two
 * people the amount that flows is bounded by what each of them is on the
 * hook for. For a normal split where one person paid and both owe, the
 * counterparty's owed share is what they owe the payer. For payments, the
 * whole cost flows from payer to receiver.
 *
 * This mirrors how Splitwise shows "you are owed X for Dinner" on an expense
 * card, so the explanation matches what the user sees in the app.
 */
/** Total the amounts of a set of contributions. */
function sum(list: Contribution[]): Minor {
  return list.reduce((acc, c) => acc + c.amount, 0);
}

export function explainBalance(meId: number, counterpartyId: number, expenses: SwExpense[], since: SinceMode = 'last_settled'): BalanceExplanation[] {
  const byCurrency = new Map<string, Contribution[]>();

  for (const e of expenses) {
    if (e.deleted_at) continue;
    const me = e.users.find((u) => u.user_id === meId);
    const them = e.users.find((u) => u.user_id === counterpartyId);
    if (!me || !them) continue;

    const myNet = toMinor(me.paid_share) - toMinor(me.owed_share);
    const theirNet = toMinor(them.paid_share) - toMinor(them.owed_share);
    if (myNet === 0 && theirNet === 0) continue;

    let amount: Minor;
    if (e.payment) {
      // A payment lowers the payer's debt. If they paid me, what they owe me
      // goes down (negative). If I paid them, what they owe me goes up.
      amount = toMinor(me.paid_share) - toMinor(them.paid_share);
    } else if (myNet > 0 && theirNet < 0) {
      amount = Math.min(myNet, -theirNet);
    } else if (myNet < 0 && theirNet > 0) {
      amount = -Math.min(-myNet, theirNet);
    } else {
      // Both paid or both owe: split the difference proportionally is not
      // something Splitwise does per pair; nothing flows between these two.
      continue;
    }

    const list = byCurrency.get(e.currency_code) ?? [];
    list.push({
      expenseId: e.id,
      description: e.description,
      date: e.date,
      currency: e.currency_code,
      amount,
      total: toMinor(e.cost),
      kind: e.payment ? 'payment' : 'expense',
    });
    byCurrency.set(e.currency_code, list);
  }

  return [...byCurrency.entries()].map(([currency, all]) => {
    const chronological = all.toSorted((a, b) => a.date.localeCompare(b.date));

    // Choose where the window opens. Everything before it is summarised as a
    // single brought-forward figure rather than replayed line by line.
    let cutAfter = -1;
    let mode: BalanceExplanation['since'] = 'all';
    if (since === 'last_settled') {
      mode = 'last_settled';
      let running = 0;
      for (let i = 0; i < chronological.length; i += 1) {
        running += chronological[i]!.amount;
        if (running === 0) cutAfter = i;
      }
    } else if (since === 'last_payment') {
      mode = 'last_payment';
      for (let i = chronological.length - 1; i >= 0; i -= 1) {
        if (chronological[i]!.kind === 'payment') {
          cutAfter = i;
          break;
        }
      }
    } else if (typeof since === 'object') {
      mode = 'date';
      for (let i = 0; i < chronological.length; i += 1) {
        if (chronological[i]!.date <= since.after) cutAfter = i;
      }
    }

    const open = chronological.slice(cutAfter + 1);
    const closed = chronological.slice(0, cutAfter + 1);
    const broughtForward = closed.reduce((acc, c) => acc + c.amount, 0);
    const settledOn = cutAfter >= 0 ? chronological[cutAfter]!.date : null;

    const charges = open.filter((c) => c.kind === 'expense');
    const payments = open.filter((c) => c.kind === 'payment');
    return {
      meId,
      counterpartyId,
      currency,
      net: broughtForward + sum(open),
      charged: sum(charges),
      settled: sum(payments),
      broughtForward,
      expenseCount: charges.length,
      paymentCount: payments.length,
      settledOn,
      since: mode,
      closedCount: cutAfter + 1,
      contributions: open.toSorted((a, b) => b.date.localeCompare(a.date)),
    };
  });
}
