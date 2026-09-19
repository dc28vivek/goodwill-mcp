import { describe, expect, it } from 'vitest';
import { staleBalances } from '../src/domain/stale.js';
import type { SwFriend } from '../src/splitwise/types.js';
import { LISBON_EXPENSES, ME, PRIYA, SAM } from './fixtures/lisbon.js';

const friends: SwFriend[] = [
  { ...PRIYA, groups: [], balance: [{ currency_code: 'EUR', amount: '61.00' }], updated_at: '2026-09-05T19:05:00Z' },
  { ...SAM, groups: [], balance: [{ currency_code: 'EUR', amount: '20.00' }], updated_at: '2026-09-06T09:00:00Z' },
  { id: 9, first_name: 'Settled', last_name: null, groups: [], balance: [{ currency_code: 'EUR', amount: '0.00' }], updated_at: '2026-01-01T00:00:00Z' },
];

describe('staleBalances', () => {
  it('finds balances older than the threshold, oldest first', () => {
    const now = new Date('2026-10-20T00:00:00Z');
    const stale = staleBalances(ME.id, friends, LISBON_EXPENSES, 30, now);
    expect(stale.map((s) => s.counterpartyName)).toEqual(['Priya S', 'Sam K']);
    expect(stale[0]?.ageDays).toBe(44); // last Priya activity 2026-09-05 19:00Z
    expect(stale[1]?.ageDays).toBe(43); // Sam paid on 2026-09-06 09:00Z
  });
  it('ignores settled and recent balances', () => {
    const now = new Date('2026-09-20T00:00:00Z');
    expect(staleBalances(ME.id, friends, LISBON_EXPENSES, 30, now)).toEqual([]);
  });
});
