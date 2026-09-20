import { describe, expect, it } from 'vitest';
import { ReceiptMismatch, splitByItems } from '../src/domain/items.js';

const item = (description: string, amount: string, sharedBy: number[]) => ({ description, amount, sharedBy });

describe('splitByItems', () => {
  it('charges each person for what they ordered', () => {
    const { shares, total } = splitByItems([item('Steak', '30.00', [1]), item('Salad', '10.00', [2])]);
    expect(shares.get(1)).toBe(3000);
    expect(shares.get(2)).toBe(1000);
    expect(total).toBe(4000);
  });

  it('allocates tax and tip in proportion to what was ordered', () => {
    // 30/40 and 10/40 of the food, so 75% and 25% of the 8.00 extras.
    const { shares, total } = splitByItems([item('Steak', '30.00', [1]), item('Salad', '10.00', [2])], { tax: '3.00', tip: '5.00' });
    expect(shares.get(1)).toBe(3600);
    expect(shares.get(2)).toBe(1200);
    expect(total).toBe(4800);
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('splits a shared line equally', () => {
    const { shares } = splitByItems([item('Bottle of wine', '30.00', [1, 2, 3])]);
    expect([...shares.values()]).toEqual([1000, 1000, 1000]);
  });

  it('never loses a cent on an awkward shared line', () => {
    const { shares, total } = splitByItems([item('Nachos', '10.00', [1, 2, 3])]);
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBe(total);
    expect([...shares.values()].toSorted()).toEqual([333, 333, 334]);
  });

  it('shares always sum exactly to the total, with tax and tip', () => {
    const { shares, total } = splitByItems(
      [item('A', '13.33', [1, 2]), item('B', '7.77', [2, 3]), item('C', '21.11', [1, 3])],
      { tax: '3.41', tip: '6.66' },
    );
    expect([...shares.values()].reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('refuses a receipt whose lines do not add up to the printed total', () => {
    expect(() => splitByItems([item('Steak', '30.00', [1])], { tax: '3.00', statedTotal: '40.00' })).toThrow(ReceiptMismatch);
  });

  it('accepts a receipt that does add up', () => {
    expect(() => splitByItems([item('Steak', '30.00', [1])], { tax: '3.00', statedTotal: '33.00' })).not.toThrow();
  });

  it('rejects a line nobody is assigned to', () => {
    expect(() => splitByItems([item('Mystery', '5.00', [])])).toThrow(RangeError);
  });
});
