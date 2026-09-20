import { describe, expect, it } from 'vitest';
import { fromMinor, rescaleShares, sharesBalance, splitByWeights, splitEqual, toMinor } from '../src/domain/money.js';

describe('toMinor / fromMinor', () => {
  it('parses Splitwise decimal strings', () => {
    expect(toMinor('25.0')).toBe(2500);
    expect(toMinor('13.55')).toBe(1355);
    expect(toMinor('0.5')).toBe(50);
    expect(toMinor('-5.02')).toBe(-502);
    expect(toMinor('84')).toBe(8400);
  });
  it('formats with two places', () => {
    expect(fromMinor(2500)).toBe('25.00');
    expect(fromMinor(5)).toBe('0.05');
    expect(fromMinor(-502)).toBe('-5.02');
  });
  it('rejects non-money', () => {
    expect(() => toMinor('12.345')).toThrow(RangeError);
    expect(() => toMinor('abc')).toThrow(RangeError);
  });
});

describe('splitEqual', () => {
  it('gives the remainder to the payer', () => {
    const { shares } = splitEqual(10000, [1, 2, 3], 2);
    expect(shares.get(1)).toBe(3333);
    expect(shares.get(2)).toBe(3334);
    expect(shares.get(3)).toBe(3333);
    expect(sharesBalance(10000, shares)).toBe(true);
  });
  it('handles a three-way split of 84.00 without drift', () => {
    const { shares } = splitEqual(toMinor('84'), [7, 8, 9], 7);
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBe(8400);
  });
  it('dedupes participants', () => {
    const { shares } = splitEqual(300, [1, 1, 2]);
    expect(shares.size).toBe(2);
    expect(shares.get(1)).toBe(150);
  });
});

describe('splitByWeights', () => {
  it('splits 60/40 exactly', () => {
    const { shares } = splitByWeights(10001, new Map([[1, 60], [2, 40]]));
    expect(shares.get(1)! + shares.get(2)!).toBe(10001);
    expect(shares.get(1)).toBe(6001);
  });
  it('ignores zero weights', () => {
    const { shares } = splitByWeights(1000, new Map([[1, 1], [2, 0]]));
    expect(shares.has(2)).toBe(false);
    expect(shares.get(1)).toBe(1000);
  });
});

describe('rescaleShares', () => {
  it('keeps each person\'s proportion when the cost is corrected', () => {
    const shares = new Map([[1, 2800], [2, 2800], [3, 2800]]);
    const scaled = rescaleShares(shares, 9000);
    expect([...scaled.values()]).toEqual([3000, 3000, 3000]);
  });
  it('preserves an uneven split', () => {
    const shares = new Map([[1, 6000], [2, 2000], [3, 2000]]);
    const scaled = rescaleShares(shares, 5000);
    expect(scaled.get(1)).toBe(3000);
    expect(scaled.get(2)).toBe(1000);
  });
  it('always sums exactly to the new total', () => {
    const shares = new Map([[1, 1333], [2, 777], [3, 2111]]);
    const scaled = rescaleShares(shares, 10001);
    expect([...scaled.values()].reduce((a, b) => a + b, 0)).toBe(10001);
  });
  it('falls back to an equal split when there is nothing to scale from', () => {
    const scaled = rescaleShares(new Map([[1, 0], [2, 0]]), 1000);
    expect([...scaled.values()]).toEqual([500, 500]);
  });
});
