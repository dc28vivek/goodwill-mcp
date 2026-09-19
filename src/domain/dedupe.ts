import type { SwExpense } from '../splitwise/types.js';
import { toMinor } from './money.js';

export interface ExpenseLike {
  id?: number;
  description: string;
  cost: string;
  currency_code: string;
  date: string;
  /** Payer id: the user with the largest paid_share. */
  payerId: number | null;
}

export interface DuplicateMatch {
  candidate: ExpenseLike;
  existing: ExpenseLike;
  /** 0 to 1. Above 0.8 is "likely duplicate". */
  confidence: number;
  reasons: string[];
}

const STOP = new Set(['the', 'a', 'an', 'at', 'in', 'for', 'and', 'of', 'to', 'with']);

/** Lowercase, strip punctuation, drop stop words, sort tokens. */
export function normalizeDescription(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t))
    .sort()
    .join(' ');
}

export function payerOf(e: SwExpense): number | null {
  let best: { id: number; paid: number } | null = null;
  for (const u of e.users) {
    const paid = toMinor(u.paid_share);
    if (paid > 0 && (!best || paid > best.paid)) best = { id: u.user_id, paid };
  }
  return best?.id ?? null;
}

export function toExpenseLike(e: SwExpense): ExpenseLike {
  return { id: e.id, description: e.description, cost: e.cost, currency_code: e.currency_code, date: e.date, payerId: payerOf(e) };
}

/** A stable key for the write log: same group, amount, day, payer, and words. */
export function fingerprint(groupId: number, e: ExpenseLike): string {
  const day = e.date.slice(0, 10);
  return [groupId, e.currency_code, toMinor(e.cost), day, e.payerId ?? 'x', normalizeDescription(e.description)].join('|');
}

function daysApart(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(normalizeDescription(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeDescription(b).split(' ').filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  return common / Math.max(ta.size, tb.size);
}

/**
 * Score one candidate against one existing expense.
 * Same amount and currency within one day is the strong signal. Same payer
 * and similar words push it up. Different currency or amount is never a match.
 */
export function scoreDuplicate(candidate: ExpenseLike, existing: ExpenseLike): DuplicateMatch | null {
  if (candidate.currency_code !== existing.currency_code) return null;
  if (toMinor(candidate.cost) !== toMinor(existing.cost)) return null;
  const reasons = ['same amount and currency'];
  let confidence = 0.5;

  const days = daysApart(candidate.date, existing.date);
  if (days <= 1) {
    confidence += 0.25;
    reasons.push(days === 0 ? 'same day' : 'within one day');
  } else if (days <= 3) {
    confidence += 0.1;
    reasons.push('within three days');
  } else {
    return null;
  }

  if (candidate.payerId !== null && candidate.payerId === existing.payerId) {
    confidence += 0.15;
    reasons.push('same payer');
  }

  const overlap = tokenOverlap(candidate.description, existing.description);
  if (overlap >= 0.5) {
    confidence += 0.1 * overlap;
    reasons.push(overlap === 1 ? 'same description' : 'similar description');
  }

  return { candidate, existing, confidence: Math.min(1, Number(confidence.toFixed(2))), reasons };
}

/** Find likely duplicates of `candidate` among `existing`. Best match first. */
export function findDuplicates(candidate: ExpenseLike, existing: ExpenseLike[], threshold = 0.75): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];
  for (const e of existing) {
    if (candidate.id !== undefined && e.id === candidate.id) continue;
    const m = scoreDuplicate(candidate, e);
    if (m && m.confidence >= threshold) matches.push(m);
  }
  return matches.sort((a, b) => b.confidence - a.confidence);
}

/** Group a whole expense list into duplicate clusters. Each pair reported once. */
export function findDuplicateClusters(expenses: ExpenseLike[], threshold = 0.75): DuplicateMatch[] {
  const out: DuplicateMatch[] = [];
  for (let i = 0; i < expenses.length; i += 1) {
    for (let j = i + 1; j < expenses.length; j += 1) {
      const m = scoreDuplicate(expenses[i]!, expenses[j]!);
      if (m && m.confidence >= threshold) out.push(m);
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/** One line from a card or bank statement, as the model parsed it. */
export interface Transaction {
  date: string;
  /** Decimal string, positive. */
  amount: string;
  description: string;
  currency_code: string;
}

export interface MissingExpense {
  transaction: Transaction;
  /** Weak matches worth showing so the user can judge. Empty when nothing was close. */
  near: { expenseId: number; description: string; date: string; confidence: number }[];
}

/**
 * Find statement lines that are not in Splitwise yet.
 *
 * The inverse of findDuplicates: instead of asking "is this already here
 * twice", it asks "is this here at all". A transaction counts as present when
 * an expense the user paid for matches it on amount, currency and date, using
 * the same scoring as duplicate detection.
 *
 * `paidByMe` must be the expenses where this user was the payer. A charge on
 * your card means you paid, so an expense someone else paid is never a match.
 */
export function findMissingExpenses(transactions: Transaction[], paidByMe: ExpenseLike[], threshold = 0.75): MissingExpense[] {
  const missing: MissingExpense[] = [];
  for (const t of transactions) {
    const candidate: ExpenseLike = { description: t.description, cost: t.amount, currency_code: t.currency_code, date: t.date, payerId: null };
    const scored = paidByMe
      .map((e) => scoreDuplicate({ ...candidate, payerId: e.payerId }, e))
      .filter((m): m is DuplicateMatch => m !== null)
      .sort((a, b) => b.confidence - a.confidence);
    if (scored.some((m) => m.confidence >= threshold)) continue;
    missing.push({
      transaction: t,
      near: scored.slice(0, 2).map((m) => ({
        expenseId: m.existing.id ?? 0,
        description: m.existing.description,
        date: m.existing.date,
        confidence: m.confidence,
      })),
    });
  }
  return missing;
}
