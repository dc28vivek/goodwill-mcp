import { describe, expect, it } from 'vitest';
import { settlePlan } from '../src/domain/settle.js';

describe('settlePlan', () => {
  it('produces n-1 payments for a simple group', () => {
    // Vivek is owed 81, Priya owes 61, Sam owes 20.
    const plan = settlePlan(new Map([[1, 8100], [2, -6100], [3, -2000]]));
    expect(plan).toEqual([
      { from: 2, to: 1, amount: 6100 },
      { from: 3, to: 1, amount: 2000 },
    ]);
  });
  it('chains debts through the middle person', () => {
    // A is owed 50, B owes 20 and is owed 30 (net +10), C owes 60.
    const plan = settlePlan(new Map([[1, 5000], [2, 1000], [3, -6000]]));
    expect(plan.reduce((a, p) => a + p.amount, 0)).toBe(6000);
    expect(plan).toHaveLength(2);
  });
  it('rejects positions that do not sum to zero', () => {
    expect(() => settlePlan(new Map([[1, 100], [2, -50]]))).toThrow(RangeError);
  });
  it('returns nothing when everyone is settled', () => {
    expect(settlePlan(new Map([[1, 0], [2, 0]]))).toEqual([]);
  });
});
