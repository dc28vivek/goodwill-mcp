import type { SwExpense } from '../splitwise/types.js';
import { type Minor, toMinor } from './money.js';

export interface Contribution {
  expenseId: number;
  description: string;
  date: string;
  currency: string;
  /** Positive: the counterparty owes `me` from this expense. Negative: I owe them. */
  amount: Minor;
  kind: 'expense' | 'payment';
}

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
  expenseCount: number;
  paymentCount: number;
  /**
   * The date the previous period was settled, if it ever was. Everything on or
   * before this is closed and is left out of the figures above.
   */
  settledOn: string | null;
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
export function explainBalance(meId: number, counterpartyId: number, expenses: SwExpense[]): BalanceExplanation[] {
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
      kind: e.payment ? 'payment' : 'expense',
    });
    byCurrency.set(e.currency_code, list);
  }

  return [...byCurrency.entries()].map(([currency, all]) => {
    const chronological = [...all].sort((a, b) => a.date.localeCompare(b.date));

    // Everything up to the last moment the balance stood at zero is closed.
    // Explaining a balance means explaining what has happened since then, not
    // replaying years of settled history.
    let running = 0;
    let lastZero = -1;
    for (let i = 0; i < chronological.length; i += 1) {
      running += chronological[i]!.amount;
      if (running === 0) lastZero = i;
    }
    const open = chronological.slice(lastZero + 1);
    const settledOn = lastZero >= 0 ? chronological[lastZero]!.date : null;

    const expenses = open.filter((c) => c.kind === 'expense');
    const payments = open.filter((c) => c.kind === 'payment');
    const sum = (list: Contribution[]) => list.reduce((acc, c) => acc + c.amount, 0);
    return {
      meId,
      counterpartyId,
      currency,
      net: sum(open),
      charged: sum(expenses),
      settled: sum(payments),
      expenseCount: expenses.length,
      paymentCount: payments.length,
      settledOn,
      closedCount: lastZero + 1,
      contributions: open.sort((a, b) => b.date.localeCompare(a.date)),
    };
  });
}
