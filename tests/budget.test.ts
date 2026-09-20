import { describe, expect, it } from 'vitest';
import { MemoryBudget, step } from '../src/store/budget.js';

describe('token bucket', () => {
  it('starts full and spends down', () => {
    const a = step(undefined, 1, 0, { capacity: 3, refillPerSecond: 1 });
    expect(a.verdict).toEqual({ ok: true, remaining: 2, retryAfterMs: 0 });
    const b = step(a.state, 2, 0, { capacity: 3, refillPerSecond: 1 });
    expect(b.verdict.ok).toBe(true);
    expect(b.verdict.remaining).toBe(0);
  });

  it('refuses when empty and says how long to wait', () => {
    const empty = { tokens: 0, updatedAt: 0 };
    const v = step(empty, 1, 0, { capacity: 3, refillPerSecond: 2 }).verdict;
    expect(v.ok).toBe(false);
    expect(v.retryAfterMs).toBe(500);
  });

  it('refills over time but never past capacity', () => {
    const empty = { tokens: 0, updatedAt: 0 };
    expect(step(empty, 1, 1000, { capacity: 3, refillPerSecond: 1 }).verdict.ok).toBe(true);
    expect(step(empty, 3, 60_000, { capacity: 3, refillPerSecond: 1 }).state.tokens).toBe(0);
    expect(step(empty, 0, 60_000, { capacity: 3, refillPerSecond: 1 }).state.tokens).toBe(3);
  });

  it('a runaway loop is stopped and a normal burst is not', async () => {
    let t = 0;
    // A question costs 7 to 15 upstream calls, so ten in a row must fit.
    const b = new MemoryBudget({ capacity: 150, refillPerSecond: 1.5 }, () => t);
    for (let i = 0; i < 150; i += 1) expect((await b.take(1)).ok).toBe(true);
    expect((await b.take(1)).ok).toBe(false);
    t += 10_000;
    expect((await b.take(1)).ok).toBe(true);
  });
});
