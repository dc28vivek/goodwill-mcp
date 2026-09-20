import { describe, expect, it } from 'vitest';
import { signState, verifyState } from '../src/server/authState.js';

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
