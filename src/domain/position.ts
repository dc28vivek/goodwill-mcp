import type { SwFriend } from '../splitwise/types.js';
import { type Minor, toMinor } from './money.js';

export interface PersonPosition {
  userId: number;
  name: string;
  amount: Minor;
}

export interface OverallPosition {
  currency: string;
  /** Sum of everything owed to me. Always positive. */
  owedToMe: Minor;
  /** Sum of everything I owe. Always positive. */
  iOwe: Minor;
  /** owedToMe minus iOwe. Positive means I am up overall. */
  net: Minor;
  owedToMeBy: PersonPosition[];
  iOweTo: PersonPosition[];
}

function fullName(f: { first_name: string; last_name: string | null }): string {
  return [f.first_name, f.last_name].filter(Boolean).join(' ');
}

/**
 * Total position across every friend and group, per currency.
 *
 * Splitwise reports a per-friend balance that already nets each friendship
 * across all shared groups, so summing the friend balances gives the overall
 * picture without double counting. Currencies are never mixed.
 */
export function overallPosition(friends: SwFriend[]): OverallPosition[] {
  const byCurrency = new Map<string, { owed: PersonPosition[]; owing: PersonPosition[] }>();

  for (const f of friends) {
    for (const b of f.balance) {
      const amount = toMinor(b.amount);
      if (amount === 0) continue;
      const bucket = byCurrency.get(b.currency_code) ?? { owed: [], owing: [] };
      const entry: PersonPosition = { userId: f.id, name: fullName(f), amount: Math.abs(amount) };
      if (amount > 0) bucket.owed.push(entry);
      else bucket.owing.push(entry);
      byCurrency.set(b.currency_code, bucket);
    }
  }

  const biggestFirst = (a: PersonPosition, b: PersonPosition) => b.amount - a.amount || a.userId - b.userId;
  return [...byCurrency.entries()]
    .map(([currency, { owed, owing }]) => {
      const owedToMe = owed.reduce((acc, p) => acc + p.amount, 0);
      const iOwe = owing.reduce((acc, p) => acc + p.amount, 0);
      return {
        currency,
        owedToMe,
        iOwe,
        net: owedToMe - iOwe,
        owedToMeBy: owed.sort(biggestFirst),
        iOweTo: owing.sort(biggestFirst),
      };
    })
    .sort((a, b) => b.owedToMe + b.iOwe - (a.owedToMe + a.iOwe));
}
