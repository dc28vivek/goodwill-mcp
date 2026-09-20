import { type Minor, splitByWeights, toMinor } from './money.js';

/** One line from a receipt, and who is on the hook for it. */
export interface ReceiptItem {
  description: string;
  /** Line total as printed, decimal string. */
  amount: string;
  /** User ids sharing this line. One person, some people, or everyone. */
  sharedBy: number[];
}

export interface ItemisedSplit {
  /** userId -> what they owe, in minor units. Sums exactly to the grand total. */
  shares: Map<number, Minor>;
  /** userId -> their items subtotal, before tax and tip. */
  subtotals: Map<number, Minor>;
  itemsTotal: Minor;
  tax: Minor;
  tip: Minor;
  total: Minor;
}

export class ReceiptMismatch extends Error {
  constructor(
    readonly itemsTotal: Minor,
    readonly extras: Minor,
    readonly stated: Minor,
  ) {
    super('Receipt lines do not add up to the stated total');
    this.name = 'ReceiptMismatch';
  }
}

/**
 * Split a receipt by line item, allocating tax and tip in proportion to what
 * each person ordered.
 *
 * Someone who ordered 80% of the food pays 80% of the tax and tip. That is
 * fairer than splitting extras equally and is what people mean by "split by
 * items". Shared lines divide equally among the people on them.
 *
 * If `statedTotal` is given and the parts do not add up to it, this throws
 * rather than posting a wrong split. A receipt read from a photo can be
 * misread, and a silent mismatch becomes a wrong balance for several people.
 */
export function splitByItems(items: ReceiptItem[], opts: { tax?: string; tip?: string; statedTotal?: string } = {}): ItemisedSplit {
  if (items.length === 0) throw new RangeError('A receipt needs at least one line');

  const subtotals = new Map<number, Minor>();
  let itemsTotal = 0;

  for (const item of items) {
    const amount = toMinor(item.amount);
    if (amount < 0) throw new RangeError(`Line "${item.description}" has a negative amount`);
    const people = [...new Set(item.sharedBy)];
    if (people.length === 0) throw new RangeError(`Nobody is assigned to "${item.description}"`);
    itemsTotal += amount;
    // Split this line equally; the remainder goes to the first person on it,
    // deterministically, so the same receipt always splits the same way.
    const base = Math.floor(amount / people.length);
    let remainder = amount - base * people.length;
    for (const id of people) {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      subtotals.set(id, (subtotals.get(id) ?? 0) + base + extra);
    }
  }

  const tax = opts.tax ? toMinor(opts.tax) : 0;
  const tip = opts.tip ? toMinor(opts.tip) : 0;
  const extras = tax + tip;
  const total = itemsTotal + extras;

  if (opts.statedTotal !== undefined) {
    const stated = toMinor(opts.statedTotal);
    if (stated !== total) throw new ReceiptMismatch(itemsTotal, extras, stated);
  }

  const shares = new Map(subtotals);
  if (extras !== 0) {
    // Allocate tax and tip in proportion to each person's subtotal.
    const allocated = splitByWeights(extras, subtotals);
    for (const [id, amount] of allocated.shares) shares.set(id, (shares.get(id) ?? 0) + amount);
  }

  return { shares, subtotals, itemsTotal, tax, tip, total };
}
