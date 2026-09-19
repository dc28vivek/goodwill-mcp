/**
 * Deterministic sentence parser for `add_expense`. See ADR-0007.
 *
 * Handles the shapes people actually type:
 *   "dinner 84"                         -> cost 84, I paid, split with everyone
 *   "dinner 84, I paid, split with everyone"
 *   "Priya paid 40 for taxi, split with me and Sam"
 *   "groceries €52.30 split between me, Sam and Alex"
 *   "84 eur dinner yesterday"
 *
 * It returns what it is sure about and a list of what is still open. The
 * caller resolves names against the group and asks the user about the rest.
 */

export interface ParsedExpense {
  description: string | null;
  cost: string | null;
  currency: string | null;
  /** "me" or a name as typed. */
  payer: string | null;
  /** Names as typed. "everyone" means the whole group. */
  participants: string[] | 'everyone' | null;
  /** ISO date (YYYY-MM-DD) when the sentence said when. */
  date: string | null;
  open: string[];
}

const CURRENCY_SYMBOLS: Record<string, string> = { '€': 'EUR', '$': 'USD', '£': 'GBP', '₹': 'INR', '¥': 'JPY' };
const CURRENCY_CODES = /\b(EUR|USD|GBP|INR|JPY|CAD|AUD|CHF|SGD|AED|MXN|BRL|SEK|NOK|DKK|PLN|CZK|THB|IDR|MYR|PHP|VND|KRW|CNY|HKD|NZD|ZAR|TRY|RUB|eur|usd|gbp|inr|rs|rupees|dollars|euros|pounds|bucks|quid)\b/;

const AMOUNT = /(?:([€$£₹¥])\s?)?(\d+(?:[.,]\d{1,2})?)(?:\s?([€$£₹¥]))?/;

function normalizeCode(word: string): string {
  const w = word.toLowerCase();
  if (['rs', 'rupees'].includes(w)) return 'INR';
  if (['dollars', 'bucks'].includes(w)) return 'USD';
  if (w === 'euros') return 'EUR';
  if (['pounds', 'quid'].includes(w)) return 'GBP';
  return word.toUpperCase();
}

function splitNames(text: string): string[] {
  return text
    .replace(/\band\b/gi, ',')
    .replace(/&/g, ',')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function relativeDate(text: string, today: Date): string | null {
  const t = text.toLowerCase();
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (/\byesterday\b/.test(t)) d.setUTCDate(d.getUTCDate() - 1);
  else if (/\btoday\b/.test(t)) {
    // no change
  } else if (/\bday before yesterday\b/.test(t)) d.setUTCDate(d.getUTCDate() - 2);
  else {
    const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    if (iso) return iso[1]!;
    return null;
  }
  return d.toISOString().slice(0, 10);
}

export function parseExpenseSentence(sentence: string, today: Date = new Date()): ParsedExpense {
  let text = sentence.trim();
  const open: string[] = [];

  // Date words.
  const date = relativeDate(text, today);
  text = text.replace(/\b(yesterday|today|day before yesterday|\d{4}-\d{2}-\d{2})\b/gi, ' ');

  // Currency code words.
  let currency: string | null = null;
  const code = text.match(CURRENCY_CODES);
  if (code) {
    currency = normalizeCode(code[1]!);
    text = text.replace(code[0], ' ');
  }

  // Amount, with an optional symbol on either side.
  let cost: string | null = null;
  const amt = text.match(AMOUNT);
  if (amt) {
    const symbol = amt[1] ?? amt[3];
    if (symbol && !currency) currency = CURRENCY_SYMBOLS[symbol] ?? null;
    cost = amt[2]!.replace(',', '.');
    if (!cost.includes('.')) cost = `${cost}.00`;
    else if (/\.\d$/.test(cost)) cost = `${cost}0`;
    text = text.replace(amt[0], ' ');
  } else {
    open.push('cost');
  }

  // Payer: "I paid", "Priya paid", "paid by Sam".
  let payer: string | null = null;
  const paidBy = text.match(/\bpaid by ([A-Za-z]+)/i);
  const xPaid = text.match(/\b(I|me|[A-Z][a-z]+) paid\b/);
  if (paidBy) {
    payer = paidBy[1]!;
    text = text.replace(paidBy[0], ' ');
  } else if (xPaid) {
    payer = /^(I|me)$/i.test(xPaid[1]!) ? 'me' : xPaid[1]!;
    text = text.replace(xPaid[0], ' ');
  } else {
    payer = 'me';
  }

  // Participants: "split with everyone", "split between me, Sam and Alex", "with Sam".
  let participants: string[] | 'everyone' | null = null;
  // A name list: "me, Sam and Alex", "everyone", "Sam & Alex".
  const NAME_LIST = String.raw`((?:[A-Za-z]+(?:\s*,\s*|\s+and\s+|\s*&\s*))*[A-Za-z]+(?:\s+(?:group|of us))?)`;
  const splitWith = text.match(new RegExp(String.raw`\b(?:split(?:ted)?\s+)?(?:with|between|among|amongst)\s+` + NAME_LIST, 'i'));
  if (splitWith) {
    const names = splitWith[1]!.trim();
    if (/^(everyone|everybody|all|the group|the whole group|all of us)$/i.test(names)) participants = 'everyone';
    else participants = splitNames(names);
    text = text.replace(splitWith[0], ' ');
  } else {
    participants = 'everyone';
  }
  text = text.replace(/\bsplit(?:ted)?\b/gi, ' ').replace(/\bequally\b/gi, ' ');

  // Description: whatever is left, minus filler.
  const description = text
    .replace(/\bfor\b/gi, ' ')
    .replace(/[,;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!description) open.push('description');

  return {
    description: description || null,
    cost,
    currency,
    payer,
    participants,
    date,
    open,
  };
}
