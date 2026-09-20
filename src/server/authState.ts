/**
 * Signed, self-contained OAuth state.
 *
 * The first version parked the pending AuthRequest in KV under a random nonce,
 * redirected to Splitwise, and read it back in /callback. KV gives no
 * read-after-write guarantee across colos, so a login that came back through a
 * different point of presence found nothing and was told its link had expired.
 * It works most of the time, which is what makes it bad: the failure is a
 * fraction of logins and it is indistinguishable in the logs from a real
 * expiry.
 *
 * The fix is to carry the request instead of storing it. The state parameter is
 * round-tripped by the authorization server by definition, so signing the
 * request into it removes the store, the TTL and the failure mode together. The
 * HMAC key is the one already configured for multi round-trip confirmations.
 *
 * Roughly 400 characters on the wire for a typical request, well inside what a
 * query parameter carries. See ADR-0015.
 */

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string | Uint8Array): Promise<CryptoKey> {
  const raw = typeof secret === 'string' ? encoder.encode(secret) : secret;
  return await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Wrap a payload with an expiry and sign it. The result is URL-safe. */
export async function signState(secret: string | Uint8Array, payload: unknown, ttlSeconds: number, now = Date.now()): Promise<string> {
  const body = b64url(encoder.encode(JSON.stringify({ e: Math.floor(now / 1000) + ttlSeconds, p: payload })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

export type StateFailure = 'malformed' | 'bad_signature' | 'expired';

/**
 * Verify and unwrap. Returns the reason on failure so /callback can say
 * something true rather than guessing at an expiry.
 */
export async function verifyState<T>(secret: string | Uint8Array, token: string, now = Date.now()): Promise<{ ok: true; payload: T } | { ok: false; reason: StateFailure }> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed' };
  const body = token.slice(0, dot);
  let sig: Uint8Array;
  try {
    sig = unb64url(token.slice(dot + 1));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig as BufferSource, encoder.encode(body));
  if (!valid) return { ok: false, reason: 'bad_signature' };
  let wrapper: { e?: number; p?: unknown };
  try {
    wrapper = JSON.parse(new TextDecoder().decode(unb64url(body))) as { e?: number; p?: unknown };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof wrapper.e !== 'number') return { ok: false, reason: 'malformed' };
  if (wrapper.e * 1000 <= now) return { ok: false, reason: 'expired' };
  return { ok: true, payload: wrapper.p as T };
}
