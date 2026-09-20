import { describe, expect, it } from 'vitest';
import { allowed, isOpen } from '../src/server/access.js';

const env = (ALLOWED_EMAILS: string) => ({ ALLOWED_EMAILS });

describe('who may connect', () => {
  it('lets nobody in when unset, which is what an unconfigured deployment does', () => {
    expect(allowed(env(''), 'anyone@example.com')).toBe(false);
    expect(allowed(env('   '), 'anyone@example.com')).toBe(false);
    expect(isOpen(env(''))).toBe(false);
  });

  it('matches an exact address, ignoring case and spacing', () => {
    const e = env(' Alice@Example.com , bob@example.com ');
    expect(allowed(e, 'alice@example.com')).toBe(true);
    expect(allowed(e, 'ALICE@EXAMPLE.COM')).toBe(true);
    expect(allowed(e, 'bob@example.com')).toBe(true);
    expect(allowed(e, 'carol@example.com')).toBe(false);
  });

  it('matches a whole domain when one is listed', () => {
    const e = env('@splitwise.com, friend@gmail.com');
    expect(allowed(e, 'anyone@splitwise.com')).toBe(true);
    expect(allowed(e, 'friend@gmail.com')).toBe(true);
    expect(allowed(e, 'stranger@gmail.com')).toBe(false);
  });

  it('does not treat a domain entry as a suffix match', () => {
    const e = env('@splitwise.com');
    // notsplitwise.com ends with the listed text but is a different domain.
    expect(allowed(e, 'someone@notsplitwise.com')).toBe(false);
    expect(allowed(e, 'someone@splitwise.com.evil.test')).toBe(false);
  });

  it('opens to everyone only on an explicit star', () => {
    expect(allowed(env('*'), 'anyone@anywhere.test')).toBe(true);
    expect(isOpen(env('*'))).toBe(true);
    expect(isOpen(env('a@b.test'))).toBe(false);
  });

  it('keeps clearing the config and opening it apart', () => {
    // An empty value is the accident. The star is the decision.
    expect(allowed(env(''), 'anyone@anywhere.test')).toBe(false);
    expect(allowed(env('*'), 'anyone@anywhere.test')).toBe(true);
  });

  it('still honours named entries alongside a star', () => {
    expect(allowed(env('*, alice@example.com'), 'zed@elsewhere.test')).toBe(true);
  });
});
