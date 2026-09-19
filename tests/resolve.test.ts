import { describe, expect, it } from 'vitest';
import { describeResolution, resolveMember } from '../src/server/resolve.js';
import { LISBON, ME } from './fixtures/lisbon.js';

describe('resolveMember', () => {
  it('resolves me, first names, ids, and full names', () => {
    expect(resolveMember(LISBON, 'me', ME.id)).toMatchObject({ ok: true, user: { id: 1 } });
    expect(resolveMember(LISBON, 'priya', ME.id)).toMatchObject({ ok: true, user: { id: 2 } });
    expect(resolveMember(LISBON, 3, ME.id)).toMatchObject({ ok: true, user: { id: 3 } });
    expect(resolveMember(LISBON, 'Alex Brown', ME.id)).toMatchObject({ ok: true, user: { id: 5 } });
  });
  it('reports ambiguity for two Alexes', () => {
    const r = resolveMember(LISBON, 'Alex', ME.id);
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(describeResolution('Alex', r)).toContain('matches 2 people');
  });
  it('reports unknown names', () => {
    expect(resolveMember(LISBON, 'Zed', ME.id)).toEqual({ ok: false, reason: 'not_found' });
  });
});
