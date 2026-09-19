import { describe, expect, it } from 'vitest';
import { overallPosition } from '../src/domain/position.js';
import type { SwFriend } from '../src/splitwise/types.js';

const friend = (id: number, name: string, balances: [string, string][]): SwFriend => ({
  id,
  first_name: name,
  last_name: null,
  groups: [],
  balance: balances.map(([currency_code, amount]) => ({ currency_code, amount })),
  updated_at: '2026-09-01T00:00:00Z',
});

describe('overallPosition', () => {
  it('splits what is owed to me from what I owe', () => {
    const [eur] = overallPosition([
      friend(2, 'Priya', [['EUR', '61.00']]),
      friend(3, 'Sam', [['EUR', '20.00']]),
      friend(4, 'Alex', [['EUR', '-15.50']]),
    ]);
    expect(eur).toMatchObject({ currency: 'EUR', owedToMe: 8100, iOwe: 1550, net: 6550 });
    expect(eur?.owedToMeBy.map((p) => p.name)).toEqual(['Priya', 'Sam']);
    expect(eur?.iOweTo.map((p) => p.name)).toEqual(['Alex']);
  });
  it('never mixes currencies', () => {
    const out = overallPosition([friend(2, 'Priya', [['EUR', '61.00'], ['INR', '-500.00']])]);
    expect(out.map((o) => o.currency).sort()).toEqual(['EUR', 'INR']);
    expect(out.find((o) => o.currency === 'INR')?.iOwe).toBe(50000);
  });
  it('ignores settled friends', () => {
    expect(overallPosition([friend(2, 'Priya', [['EUR', '0.00']])])).toEqual([]);
  });
  it('sorts each side biggest first', () => {
    const [eur] = overallPosition([
      friend(2, 'Small', [['EUR', '5.00']]),
      friend(3, 'Big', [['EUR', '500.00']]),
    ]);
    expect(eur?.owedToMeBy[0]?.name).toBe('Big');
  });
});
