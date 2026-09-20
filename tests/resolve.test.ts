import { describe, expect, it } from 'vitest';
import { describeResolution, resolveInvitee, resolveMember } from '../src/server/resolve.js';
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
