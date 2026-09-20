import { type Minor } from './money.js';

export interface Payment {
  from: number;
  to: number;
  amount: Minor;
}

/**
 * Minimum cash flow settlement.
 *
 * Input: each person's net position in one currency. Positive means they are
 * owed, negative means they owe. Positions must sum to zero.
 *
 * Greedy pairing of the largest debtor with the largest creditor. This gives
 * at most n-1 payments and matches what Splitwise's "simplify debts" shows in
 * the common cases. Ties are broken by user id so the output is deterministic.
 */
/** Largest debt first, ties broken by id so the plan is deterministic. */
function byAmtThenId(a: { id: number; amt: Minor }, b: { id: number; amt: Minor }): number {
  return b.amt - a.amt || a.id - b.id;
}

export function settlePlan(positions: Map<number, Minor>): Payment[] {
  const debtors: { id: number; amt: Minor }[] = [];
  const creditors: { id: number; amt: Minor }[] = [];
  let sum = 0;
  for (const [id, amt] of positions) {
    sum += amt;
    if (amt < 0) debtors.push({ id, amt: -amt });
    else if (amt > 0) creditors.push({ id, amt });
  }
  if (sum !== 0) throw new RangeError(`Positions do not sum to zero (sum=${sum})`);

  debtors.sort(byAmtThenId);
  creditors.sort(byAmtThenId);

  const payments: Payment[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i]!;
    const c = creditors[j]!;
    const amount = Math.min(d.amt, c.amt);
    payments.push({ from: d.id, to: c.id, amount });
    d.amt -= amount;
    c.amt -= amount;
    if (d.amt === 0) i += 1;
    if (c.amt === 0) j += 1;
  }
  return payments;
}

/** Turn a group's member balances (one currency) into net positions. */
export function positionsFromBalances(balances: { userId: number; amount: Minor }[]): Map<number, Minor> {
  const m = new Map<number, Minor>();
  for (const b of balances) m.set(b.userId, (m.get(b.userId) ?? 0) + b.amount);
  return m;
}
