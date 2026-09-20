import { describe, expect, it } from 'vitest';
import { describeGroupResolution, describeResolution, resolveGroup, resolveInvitee, resolveMember } from '../src/server/resolve.js';
import { ALEX_A, ALEX_B, LISBON, ME, PRIYA, SAM } from './fixtures/lisbon.js';

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

describe('resolveInvitee', () => {
  const friends = [
    { ...PRIYA, email: 'priya@example.com' },
    { ...SAM, email: 'sam@example.com' },
    ALEX_A,
    ALEX_B,
  ];

  it('matches an existing friend by name', () => {
    expect(resolveInvitee('Priya', friends, ME.id)).toMatchObject({ kind: 'existing', user: { id: 2 } });
  });

  it('matches an existing friend by their email, rather than re-inviting them', () => {
    expect(resolveInvitee('PRIYA@example.com', friends, ME.id)).toMatchObject({ kind: 'existing', user: { id: 2 } });
  });

  it('treats an unknown email as a new invitation and guesses a name', () => {
    expect(resolveInvitee('nisha.rao@example.com', friends, ME.id)).toEqual({
      kind: 'invite', firstName: 'Nisha', lastName: 'Rao', email: 'nisha.rao@example.com',
    });
  });

  it('prefers an explicitly given name over one guessed from the address', () => {
    expect(resolveInvitee('Nisha Rao <nr99@example.com>', friends, ME.id)).toEqual({
      kind: 'invite', firstName: 'Nisha', lastName: 'Rao', email: 'nr99@example.com',
    });
  });

  it('refuses a malformed address instead of inviting nobody', () => {
    expect(resolveInvitee('nisha@@example', friends, ME.id)).toMatchObject({ kind: 'unresolved' });
  });

  it('reports an ambiguous name rather than picking one', () => {
    const r = resolveInvitee('Alex', friends, ME.id);
    expect(r.kind).toBe('unresolved');
    expect((r as { reason: string }).reason).toContain('matches 2 people');
  });

  it('reports an unknown plain name, since it cannot be invited without an address', () => {
    expect(resolveInvitee('Zed', friends, ME.id)).toMatchObject({ kind: 'unresolved' });
  });
});

describe('resolveGroup', () => {
  const groups = [
    { id: 0, name: 'Non-group expenses' },
    { id: 100, name: 'Lisbon' },
    { id: 200, name: 'Deewani' },
    { id: 300, name: 'Lisbon 2027' },
  ] as unknown as Parameters<typeof resolveGroup>[0];

  it('matches an exact name, whatever the case', () => {
    const r = resolveGroup(groups, 'deewani');
    expect(r.ok && r.group.id).toBe(200);
  });

  it('prefers an exact name over a longer one that starts the same way', () => {
    const r = resolveGroup(groups, 'Lisbon');
    expect(r.ok && r.group.id).toBe(100);
  });

  it('matches on a prefix when nothing is exact', () => {
    const r = resolveGroup(groups, 'Lisbon 2');
    expect(r.ok && r.group.id).toBe(300);
  });

  it('matches a word inside the name', () => {
    const r = resolveGroup(groups, '2027');
    expect(r.ok && r.group.id).toBe(300);
  });

  it('takes an id, as a number or a string', () => {
    for (const ref of [200, '200'] as const) {
      const r = resolveGroup(groups, ref);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.group.id).toBe(200);
    }
  });

  it('falls back to a name when a digits-only reference is not an id', () => {
    // "2027" looks like an id and is not one, but it is a perfectly good way
    // to mean "Lisbon 2027".
    const r = resolveGroup(groups, '2027');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.group.id).toBe(300);
  });

  it('never resolves group 0, which is not a real group', () => {
    const r = resolveGroup(groups, 0);
    expect(r.ok).toBe(false);
    const byName = resolveGroup(groups, 'Non-group expenses');
    expect(byName.ok).toBe(false);
  });

  it('reports ambiguity with the options rather than guessing', () => {
    const r = resolveGroup([{ id: 1, name: 'Trip' }, { id: 2, name: 'Trip' }] as unknown as Parameters<typeof resolveGroup>[0], 'Trip');
    expect(r.ok).toBe(false);
    expect(describeGroupResolution('Trip', r)).toContain('matches 2 groups');
  });

  it('lists what does exist when nothing matches', () => {
    const r = resolveGroup(groups, 'Reykjavik');
    expect(r.ok).toBe(false);
    const message = describeGroupResolution('Reykjavik', r);
    expect(message).toContain('Deewani (id 200)');
    expect(message).not.toContain('Non-group expenses');
  });
});
