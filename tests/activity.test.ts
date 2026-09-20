import { describe, expect, it } from 'vitest';
import { toActivity, toPlainText } from '../src/domain/activity.js';
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
