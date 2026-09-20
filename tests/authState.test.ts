import { describe, expect, it } from 'vitest';
import { bindingDigest, newBinding, readCookie, safeEqual, signState, verifyState } from '../src/server/authState.js';

const KEY = 'a'.repeat(32);

interface AuthLike {
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
  codeChallenge: string;
}

const request: AuthLike = {
  clientId: 'https://claude.ai/.well-known/oauth-client',
  redirectUri: 'https://claude.ai/api/mcp/auth_callback',
  scope: ['read', 'add'],
  state: 'Zm9vYmFyYmF6cXV1eA',
  codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
};

describe('signed OAuth state', () => {
  it('round-trips the pending request', async () => {
    const token = await signState(KEY, request, 600);
    const out = await verifyState<AuthLike>(KEY, token);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.payload).toEqual(request);
  });

  it('is URL safe and small enough for a query parameter', async () => {
    const token = await signState(KEY, request, 600);
    expect(token).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
    expect(token.length).toBeLessThan(800);
  });

  it('rejects a tampered payload', async () => {
    const token = await signState(KEY, request, 600);
    const dot = token.lastIndexOf('.');
    const flipped = `${token.slice(0, dot - 1)}${token[dot - 1] === 'A' ? 'B' : 'A'}${token.slice(dot)}`;
    expect(await verifyState(KEY, flipped)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a signature from another key', async () => {
    const token = await signState('b'.repeat(32), request, 600);
    expect(await verifyState(KEY, token)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('reports expiry apart from a bad signature, so the message can be true', async () => {
    const token = await signState(KEY, request, 600, 1_000_000);
    expect(await verifyState(KEY, token, 1_000_000 + 601_000)).toEqual({ ok: false, reason: 'expired' });
    expect((await verifyState(KEY, token, 1_000_000 + 599_000)).ok).toBe(true);
  });

  it('rejects junk without throwing', async () => {
    expect(await verifyState(KEY, 'nonsense')).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyState(KEY, '')).toEqual({ ok: false, reason: 'malformed' });
    expect((await verifyState(KEY, 'aaaa.!!!!')).ok).toBe(false);
  });
});

describe('browser binding', () => {
  it('a binding is unguessable and its digest is stable', async () => {
    const a = newBinding();
    const b = newBinding();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(await bindingDigest(a)).toBe(await bindingDigest(a));
    expect(await bindingDigest(a)).not.toBe(await bindingDigest(b));
    expect(await bindingDigest(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the digest does not reveal the binding', async () => {
    const binding = newBinding();
    expect(await bindingDigest(binding)).not.toContain(binding.slice(0, 8));
  });

  it('safeEqual matches only identical values', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('reads one cookie out of a header and ignores the rest', () => {
    expect(readCookie('st_state=xyz', 'st_state')).toBe('xyz');
    expect(readCookie('other=1; st_state=xyz; more=2', 'st_state')).toBe('xyz');
    expect(readCookie('other=1', 'st_state')).toBeUndefined();
    expect(readCookie(null, 'st_state')).toBeUndefined();
    expect(readCookie('', 'st_state')).toBeUndefined();
    // A name that merely ends with the one we want must not match.
    expect(readCookie('not_st_state=wrong', 'st_state')).toBeUndefined();
  });

  it('a state stolen from another browser does not verify', async () => {
    // The victim starts a flow: the digest is signed in, the secret stays in
    // their browser.
    const victimBinding = newBinding();
    const state = await signState(KEY, { req: request, bind: await bindingDigest(victimBinding) }, 600);

    // The attacker replays that state from their own browser, with their own
    // cookie, alongside a code for their own Splitwise account.
    const attackerBinding = newBinding();
    const out = await verifyState<{ req: AuthLike; bind: string }>(KEY, state);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(safeEqual(await bindingDigest(attackerBinding), out.payload.bind)).toBe(false);

    // And with no cookie at all there is nothing to compare, so it is refused.
    expect(readCookie(null, 'st_state')).toBeUndefined();

    // Only the browser that started the flow gets through.
    expect(safeEqual(await bindingDigest(victimBinding), out.payload.bind)).toBe(true);
  });

  it('the binding secret never travels through Splitwise, only its digest', async () => {
    const binding = newBinding();
    const state = await signState(KEY, { req: request, bind: await bindingDigest(binding) }, 600);
    expect(state).not.toContain(binding);
  });
});
