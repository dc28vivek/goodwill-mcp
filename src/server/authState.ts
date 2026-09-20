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

/**
 * Browser binding for the signed state.
 *
 * Signing the state proves this server issued it. It does not prove the person
 * finishing the flow is the person who started it, and because the state is
 * self-contained there is no store to delete it from, so it stays valid for its
 * full ten minutes. Someone who obtains another person's state can pair it with
 * an authorization code for their own Splitwise account and have the victim's
 * client linked to the attacker's ledger, which then feeds attacker-controlled
 * expense text to the victim's agent.
 *
 * The fix costs no storage. `/authorize` puts a random value in an HttpOnly
 * cookie and the hash of that value inside the signed state. `/callback`
 * requires the two to agree, so a state is usable only in the browser that
 * started the flow, and only until the cookie is cleared. SameSite=Lax is
 * deliberate: the callback arrives as a top-level cross-site GET redirect from
 * Splitwise, which Lax allows and Strict would block.
 *
 * See ADR-0015.
 */

/** A fresh binding secret to hand to the browser. */
export function newBinding(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The hash of a binding, safe to embed in the state that travels via Splitwise. */
export async function bindingDigest(binding: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(binding));
  let out = '';
  for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Comparison that does not leak how much of the value matched. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Read one cookie out of a Cookie header. Returns undefined when absent. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
