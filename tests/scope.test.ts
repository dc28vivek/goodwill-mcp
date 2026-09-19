import { describe, expect, it } from 'vitest';
import { missingScope } from '../src/server/format.js';

describe('missingScope', () => {
  it('allows everything over stdio (no auth info)', () => {
    expect(missingScope({}, 'add')).toBeUndefined();
    expect(missingScope({ http: {} }, 'modify')).toBeUndefined();
  });
  it('allows a granted scope and refuses a missing one', () => {
    const ctx = { http: { authInfo: { scopes: ['read'] } } };
    expect(missingScope(ctx, 'read')).toBeUndefined();
    const denied = missingScope(ctx, 'add');
    expect(denied?.isError).toBe(true);
    expect((denied?.content[0] as { text: string }).text).toContain('"add" scope');
  });
});
