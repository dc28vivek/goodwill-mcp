/**
 * Money handling.
 *
 * Splitwise sends and receives amounts as decimal strings with at most two
 * decimal places ("25.0", "13.55"). We never do arithmetic on floats. Inside
 * the domain code an amount is an integer count of minor units (cents).
 * See ADR-0005.
 */

export type Minor = number;

const DECIMAL = /^-?\d+(\.\d{1,2})?$/;

/** Parse a Splitwise decimal string into minor units. Throws on bad input. */
export function toMinor(amount: string | number): Minor {
  const text = typeof amount === 'number' ? amount.toFixed(2) : amount.trim();
  if (!DECIMAL.test(text)) {
    throw new RangeError(`Not a money amount: "${amount}"`);
  }
  const negative = text.startsWith('-');
  const [whole = '0', frac = ''] = text.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return negative ? -cents : cents;
}

/** Format minor units as a Splitwise decimal string with two places. */
export function fromMinor(minor: Minor): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minor));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(frac).padStart(2, '0')}`;
}

/** Human display with a currency code, for previews. */
export function display(minor: Minor, currency: string): string {
  return `${fromMinor(minor)} ${currency}`;
}

export interface SplitResult {
  /** userId -> owed share in minor units. Shares sum exactly to the total. */
  shares: Map<number, Minor>;
}

/**
 * Split a total equally across participants. The remainder from rounding goes
 * to `remainderTo` (the payer by default), so shares always sum to the total.
 */
export function splitEqual(total: Minor, participants: number[], remainderTo?: number): SplitResult {
  if (participants.length === 0) throw new RangeError('Cannot split among zero people');
  const unique = [...new Set(participants)];
  const base = Math.floor(total / unique.length);
  const remainder = total - base * unique.length;
  const shares = new Map<number, Minor>();
  for (const id of unique) shares.set(id, base);
  const target = remainderTo !== undefined && shares.has(remainderTo) ? remainderTo : unique[0]!;
  shares.set(target, shares.get(target)! + remainder);
  return { shares };
}

/**
 * Split by weights (for example 60/40 or by income). Weights are relative.
 * Uses largest-remainder rounding so shares sum exactly to the total.
 */
export function splitByWeights(total: Minor, weights: Map<number, number>): SplitResult {
  const entries = [...weights.entries()].filter(([, w]) => w > 0);
  if (entries.length === 0) throw new RangeError('Weights must include at least one positive value');
  const sum = entries.reduce((acc, [, w]) => acc + w, 0);
  const raw = entries.map(([id, w]) => ({ id, exact: (total * w) / sum }));
  const floored = raw.map((r) => ({ id: r.id, share: Math.floor(r.exact), frac: r.exact - Math.floor(r.exact) }));
  let remainder = total - floored.reduce((acc, r) => acc + r.share, 0);
  floored.sort((a, b) => b.frac - a.frac);
  for (const r of floored) {
    if (remainder <= 0) break;
    r.share += 1;
    remainder -= 1;
  }
  return { shares: new Map(floored.map((r) => [r.id, r.share])) };
}

/** True when the shares sum exactly to the total. Splitwise rejects anything else. */
export function sharesBalance(total: Minor, shares: Map<number, Minor>): boolean {
  let sum = 0;
  for (const v of shares.values()) sum += v;
  return sum === total;
}
