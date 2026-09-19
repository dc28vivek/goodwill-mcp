import { describe, expect, it } from 'vitest';
import { explainBalance } from '../src/domain/explain.js';
import { LISBON_EXPENSES, ME, PRIYA, SAM } from './fixtures/lisbon.js';

describe('explainBalance', () => {
  it('lists the expenses behind what Priya owes Vivek', () => {
    const [eur] = explainBalance(ME.id, PRIYA.id, LISBON_EXPENSES);
    expect(eur?.currency).toBe('EUR');
    expect(eur?.net).toBe(6100);
    expect(eur?.contributions.map((c) => c.description)).toEqual(['Dinner at Cervejaria', 'Airbnb']);
  });
  it('nets a payment against expenses for Sam', () => {
    const [eur] = explainBalance(ME.id, SAM.id, LISBON_EXPENSES);
    // 28 + 33 + 8 owed, minus 49 paid back = 20
    expect(eur?.net).toBe(2000);
    const payment = eur?.contributions.find((c) => c.kind === 'payment');
    expect(payment?.amount).toBe(-4900);
  });
  it('is antisymmetric', () => {
    const [mine] = explainBalance(ME.id, PRIYA.id, LISBON_EXPENSES);
    const [theirs] = explainBalance(PRIYA.id, ME.id, LISBON_EXPENSES);
    expect(theirs?.net).toBe(-(mine?.net ?? 0));
  });
  it('skips deleted expenses', () => {
    const deleted = LISBON_EXPENSES.map((e) => ({ ...e, deleted_at: '2026-09-07T00:00:00Z' }));
    expect(explainBalance(ME.id, PRIYA.id, deleted)).toEqual([]);
  });
});
