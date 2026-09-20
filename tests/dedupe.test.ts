import { describe, expect, it } from 'vitest';
import { findDuplicateClusters, findDuplicates, findMissingExpenses, fingerprint, normalizeDescription, toExpenseLike } from '../src/domain/dedupe.js';
import { LISBON_EXPENSES } from './fixtures/lisbon.js';

describe('normalizeDescription', () => {
  it('ignores case, punctuation, order, and stop words', () => {
    expect(normalizeDescription('Dinner at the Cervejaria!')).toBe(normalizeDescription('cervejaria dinner'));
  });
});

describe('findDuplicates', () => {
  const existing = LISBON_EXPENSES.map(toExpenseLike);
  it('flags the same dinner posted twice on the same day', () => {
    const again = { description: 'dinner cervejaria', cost: '84.00', currency_code: 'EUR', date: '2026-09-05T21:00:00Z', payerId: 1 };
    const [m] = findDuplicates(again, existing);
    expect(m?.existing.description).toBe('Dinner at Cervejaria');
    expect(m?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(m?.reasons).toContain('same payer');
  });
  it('does not flag a different amount', () => {
    const other = { description: 'Dinner at Cervejaria', cost: '85.00', currency_code: 'EUR', date: '2026-09-05T21:00:00Z', payerId: 1 };
    expect(findDuplicates(other, existing)).toEqual([]);
  });
  it('does not flag the same amount a week later', () => {
    const later = { description: 'Dinner at Cervejaria', cost: '84.00', currency_code: 'EUR', date: '2026-09-12T21:00:00Z', payerId: 1 };
    expect(findDuplicates(later, existing)).toEqual([]);
  });
  it('flags same amount next day with a different description at lower confidence', () => {
    const vague = { description: 'Food', cost: '84.00', currency_code: 'EUR', date: '2026-09-06T12:00:00Z', payerId: 2 };
    const [m] = findDuplicates(vague, existing, 0.7);
    expect(m?.confidence).toBe(0.75);
  });
});

describe('fingerprint', () => {
  it('is stable across word order and time of day', () => {
    const a = fingerprint(100, { description: 'Dinner at Cervejaria', cost: '84.00', currency_code: 'EUR', date: '2026-09-05T19:00:00Z', payerId: 1 });
    const b = fingerprint(100, { description: 'cervejaria dinner', cost: '84', currency_code: 'EUR', date: '2026-09-05T23:59:00Z', payerId: 1 });
    expect(a).toBe(b);
  });
});

describe('findDuplicateClusters', () => {
  it('finds a duplicated import in a list', () => {
    const list = [...LISBON_EXPENSES.map(toExpenseLike), { ...toExpenseLike(LISBON_EXPENSES[1]!), id: 9999, date: '2026-09-04T13:00:00Z' }];
    const clusters = findDuplicateClusters(list);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.existing.id).toBe(9999);
  });
});

const tx = (date: string, amount: string, description: string) => ({ date, amount, description, currency_code: 'EUR' });

describe('findMissingExpenses', () => {
  const mine = LISBON_EXPENSES.filter((e) => !e.payment).map(toExpenseLike);

  it('reports a card charge that never made it into Splitwise', () => {
    const missing = findMissingExpenses([tx('2026-09-06T20:00:00Z', '42.00', 'BAR DA VELHA')], mine);
    expect(missing).toHaveLength(1);
    expect(missing[0]?.transaction.description).toBe('BAR DA VELHA');
    expect(missing[0]?.near).toEqual([]);
  });

  it('does not report a charge that is already logged', () => {
    expect(findMissingExpenses([tx('2026-09-05T19:30:00Z', '84.00', 'CERVEJARIA LISBOA')], mine)).toEqual([]);
  });

  it('surfaces a near match rather than claiming nothing is close', () => {
    // Same amount as the Airbnb but five days later: below threshold, still worth showing.
    const missing = findMissingExpenses([tx('2026-09-04T12:00:00Z', '99.00', 'Something else entirely')], mine, 0.99);
    expect(missing[0]?.near[0]?.description).toBe('Airbnb');
  });

  it('handles an empty statement', () => {
    expect(findMissingExpenses([], mine)).toEqual([]);
  });
});
