import { describe, expect, it } from 'vitest';
import { parseExpenseSentence } from '../src/domain/parser.js';

const today = new Date('2026-09-19T12:00:00Z');

describe('parseExpenseSentence', () => {
  it('parses the minimal case', () => {
    const p = parseExpenseSentence('dinner 84', today);
    expect(p).toMatchObject({ description: 'dinner', cost: '84.00', payer: 'me', participants: 'everyone', open: [] });
  });
  it('parses the full sentence', () => {
    const p = parseExpenseSentence('dinner 84, I paid, split with everyone', today);
    expect(p).toMatchObject({ description: 'dinner', cost: '84.00', payer: 'me', participants: 'everyone' });
  });
  it('parses another payer and named participants', () => {
    const p = parseExpenseSentence('Priya paid 40 for taxi, split with me and Sam', today);
    expect(p).toMatchObject({ description: 'taxi', cost: '40.00', payer: 'Priya', participants: ['me', 'Sam'] });
  });
  it('reads currency symbols and codes', () => {
    expect(parseExpenseSentence('groceries €52.30 split between me, Sam and Alex', today)).toMatchObject({
      description: 'groceries', cost: '52.30', currency: 'EUR', participants: ['me', 'Sam', 'Alex'],
    });
    expect(parseExpenseSentence('84 eur dinner yesterday', today)).toMatchObject({
      description: 'dinner', cost: '84.00', currency: 'EUR', date: '2026-09-18',
    });
    expect(parseExpenseSentence('auto 250 rs', today)).toMatchObject({ cost: '250.00', currency: 'INR', description: 'auto' });
  });
  it('reports what is missing', () => {
    const p = parseExpenseSentence('lunch with Sam', today);
    expect(p.open).toContain('cost');
    expect(p.participants).toEqual(['Sam']);
  });
  it('handles paid by', () => {
    const p = parseExpenseSentence('Museum tickets 30 paid by Sam', today);
    expect(p).toMatchObject({ payer: 'Sam', cost: '30.00', description: 'Museum tickets' });
  });
});
