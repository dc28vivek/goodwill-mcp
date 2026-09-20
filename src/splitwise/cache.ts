/**
 * Read-through cache for the slow-moving Splitwise endpoints.
 *
 * One question costs 7 to 15 upstream calls, and `get_current_user`,
 * `get_groups` and `get_friends` repeat in almost every one of them while
 * changing perhaps once a week. Splitwise publishes no rate limit, which means
 * the way we would discover it is by being cut off, so the cheapest call is the
 * one we do not make. See ADR-0017.
 *
 * Expenses are never cached. They are what changes and what every balance is
 * computed from, so a stale answer there is a wrong answer.
 *
 * Keys carry a hash of the token, never the token, so one user can never read
 * another user's entry even if a prefix were built wrongly.
 */

export interface TtlCache {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Per-process cache for stdio and tests. */
export class MemoryCache implements TtlCache {
  private readonly rows = new Map<string, { value: string; expires: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(key: string): Promise<string | undefined> {
    const row = this.rows.get(key);
    if (!row) return undefined;
    if (row.expires <= this.now()) {
      this.rows.delete(key);
      return undefined;
    }
    return row.value;
  }

  async put(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.rows.set(key, { value, expires: this.now() + ttlSeconds * 1000 });
  }

  async delete(key: string): Promise<void> {
    this.rows.delete(key);
  }
}

/** Minimal shape of the Workers Cache API, so this file imports no platform types. */
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
}

/**
 * Cloudflare Cache API. Per colo rather than global, which is the right trade
 * for a read cache: a cold colo costs one upstream call, never a wrong answer.
 */
export class WorkersCache implements TtlCache {
  constructor(private readonly cache: CacheLike) {}

  private req(key: string): Request {
    return new Request(`https://cache.goodwill.invalid/${encodeURIComponent(key)}`);
  }

  async get(key: string): Promise<string | undefined> {
    const hit = await this.cache.match(this.req(key));
    return hit ? await hit.text() : undefined;
  }

  async put(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.cache.put(
      this.req(key),
      new Response(value, { headers: { 'cache-control': `max-age=${ttlSeconds}`, 'content-type': 'application/json' } }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.cache.delete(this.req(key));
  }
}

export function noCache(): TtlCache {
  return {
    async get() {
      return undefined;
    },
    async put() {},
    async delete() {},
  };
}

/** Stable, non-reversible per-user cache namespace. */
export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const bytes = new Uint8Array(digest).slice(0, 8);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
