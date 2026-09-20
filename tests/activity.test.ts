import { describe, expect, it } from 'vitest';
import { changeSummary, collapseTransient, toActivity, toPlainText } from '../src/domain/activity.js';
import type { SwNotification } from '../src/splitwise/types.js';

const note = (partial: Partial<SwNotification>): SwNotification => ({
  id: 1, type: 0, created_at: '2026-09-18T10:00:00Z', created_by: 2,
  source: { type: 'Expense', id: 501, url: null }, content: 'x', ...partial,
});

describe('toPlainText', () => {
  it('strips the documented tag set', () => {
    expect(toPlainText('<strong>You</strong> paid <strong>Jon H.</strong>.<br><font color="#5bc5a7">You paid $23.45</font>'))
      .toBe('You paid Jon H.. You paid $23.45');
  });
  it('decodes entities so names read properly', () => {
    expect(toPlainText('Added <strong>Ben &amp; Jerry&#39;s</strong>')).toBe("Added Ben & Jerry's");
  });
  it('survives empty or tagless content', () => {
    expect(toPlainText('')).toBe('');
    expect(toPlainText('plain words')).toBe('plain words');
  });
});

describe('toActivity', () => {
  it('maps documented types to readable kinds', () => {
    expect(toActivity(note({ type: 0 })).kind).toBe('expense_added');
    expect(toActivity(note({ type: 3 })).kind).toBe('comment_added');
    expect(toActivity(note({ type: 11 })).kind).toBe('debts_simplified');
  });
  it('keeps an unknown future type instead of dropping the event', () => {
    const a = toActivity(note({ type: 99, content: '<strong>Something new</strong> happened' }));
    expect(a.kind).toBe('other');
    expect(a.text).toBe('Something new happened');
  });
  it('carries the source so an event can be linked back to its expense', () => {
    const a = toActivity(note({ source: { type: 'Expense', id: 777, url: null } }));
    expect(a).toMatchObject({ sourceType: 'Expense', sourceId: 777 });
  });
  it('handles a missing source', () => {
    const a = toActivity(note({ source: null }));
    expect(a.sourceId).toBeNull();
  });
});

describe('collapseTransient', () => {
  const ev = (id: number, type: number, at: string, expenseId: number | null, content = 'x'): SwNotification =>
    note({ id, type, created_at: at, content, source: expenseId === null ? null : { type: 'Expense', id: expenseId, url: null } });

  it('folds an add and a delete of the same expense into one event', () => {
    const out = collapseTransient([
      toActivity(ev(2, 2, '2026-09-16T14:00:00Z', 501, 'You deleted Costco')),
      toActivity(ev(1, 0, '2026-09-16T11:00:00Z', 501, 'You added Costco')),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe('You added Costco');
    expect(out[0]?.transient).toMatchObject({ hours: 3, absorbed: 2 });
  });

  it('absorbs an edit that happened in between', () => {
    const out = collapseTransient([
      toActivity(ev(3, 2, '2026-09-16T15:00:00Z', 501)),
      toActivity(ev(2, 1, '2026-09-16T12:00:00Z', 501)),
      toActivity(ev(1, 0, '2026-09-16T11:00:00Z', 501)),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.transient?.absorbed).toBe(3);
  });

  it('leaves a deletion of something created earlier alone', () => {
    const out = collapseTransient([toActivity(ev(1, 2, '2026-09-16T14:00:00Z', 501, 'You deleted Rent'))]);
    expect(out).toHaveLength(1);
    expect(out[0]?.transient).toBeUndefined();
    expect(out[0]?.kind).toBe('expense_deleted');
  });

  it('does not fold when the expense was restored afterwards', () => {
    const out = collapseTransient([
      toActivity(ev(3, 13, '2026-09-16T16:00:00Z', 501)),
      toActivity(ev(2, 2, '2026-09-16T14:00:00Z', 501)),
      toActivity(ev(1, 0, '2026-09-16T11:00:00Z', 501)),
    ]);
    expect(out).toHaveLength(3);
  });

  it('keeps unrelated expenses and non-expense events untouched', () => {
    const out = collapseTransient([
      toActivity(ev(2, 2, '2026-09-16T14:00:00Z', 501)),
      toActivity(ev(1, 0, '2026-09-16T11:00:00Z', 501)),
      toActivity(ev(3, 0, '2026-09-16T12:00:00Z', 777)),
      toActivity(ev(4, 5, '2026-09-16T13:00:00Z', null)),
    ]);
    expect(out).toHaveLength(3);
  });

  it('preserves the original order of what is left', () => {
    const out = collapseTransient([
      toActivity(ev(5, 0, '2026-09-18T09:00:00Z', 900, 'newest')),
      toActivity(ev(2, 2, '2026-09-16T14:00:00Z', 501)),
      toActivity(ev(1, 0, '2026-09-16T11:00:00Z', 501)),
    ]);
    expect(out.map((a) => a.id)).toEqual([5, 1]);
  });
});

describe('changeSummary', () => {
  it('extracts what changed and drops the attribution', () => {
    expect(changeSummary('John D. updated this transaction: - The cost changed from $6.99 to $8.99'))
      .toBe('The cost changed from $6.99 to $8.99');
  });
  it('joins several changes into one clause', () => {
    expect(changeSummary('Vivek updated this transaction: - The cost changed from $10 to $20 - The date changed from Sep 1 to Sep 2'))
      .toBe('The cost changed from $10 to $20; The date changed from Sep 1 to Sep 2');
  });
  it('strips HTML before parsing', () => {
    expect(changeSummary('<strong>John</strong> updated this transaction: - The description changed'))
      .toBe('The description changed');
  });
  it('returns null for a comment that describes nothing', () => {
    expect(changeSummary('Some unrelated system note')).toBeNull();
  });
});
