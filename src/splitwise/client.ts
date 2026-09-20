import { currentSpan } from '../obs/context.js';
import { SPAN_KIND } from '../obs/trace.js';
import { type Budget, OverBudget, unlimitedBudget } from '../store/budget.js';
import { type TtlCache, noCache, tokenHash } from './cache.js';
import { CircuitBreaker, sharedBreaker } from './breaker.js';
import type {
  SwAddUserToGroup,
  SwCategory,
  SwCreateGroup,
  SwComment,
  SwCreateExpenseByShares,
  SwCurrency,
  SwCurrentUser,
  SwExpense,
  SwFriend,
  SwGroup,
  SwNotification,
  SwUser,
} from './types.js';

/**
 * Typed Splitwise API client.
 *
 * The upstream host is fixed here and nowhere else. No tool argument can
 * change it (see SECURITY.md). Every call carries one user's token.
 *
 * Three guards sit in front of every request, in this order: a read-through
 * cache for the endpoints that repeat and change slowly, a circuit breaker so
 * an upstream outage is refused rather than retried by everyone at once, and a
 * per-user token bucket so one runaway loop cannot spend the whole
 * application's allowance. See ADR-0017.
 */
export const SPLITWISE_API = 'https://secure.splitwise.com/api/v3.0';

export class SplitwiseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'SplitwiseError';
  }
}

/**
 * The token was rejected, which for a non-expiring Splitwise token means the
 * person revoked it. Distinct from SplitwiseError so the caller can retire the
 * grant instead of showing a generic failure forever.
 */
export class SplitwiseUnauthorized extends SplitwiseError {
  constructor() {
    super('Splitwise rejected this connection. Sign in again to reconnect.', 401);
    this.name = 'SplitwiseUnauthorized';
  }
}

/** How long a response stays usable, by route. Absent means never cached. */
const CACHE_TTL: Record<string, number> = {
  '/get_current_user': 60,
  '/get_groups': 60,
  '/get_group/{id}': 60,
  '/get_friends': 60,
  '/get_categories': 86_400,
  '/get_currencies': 86_400,
};

/** Ids out of the path so the span attribute is a route, not a person's data. */
function route(path: string): string {
  return path.replace(/\/\d+/g, '/{id}');
}

export interface SplitwiseClientOptions {
  token: string;
  fetch?: typeof fetch;
  /** Max retries on 429 or 5xx. Default 3. */
  retries?: number;
  /** Base delay for backoff in ms. Default 500. */
  backoffMs?: number;
  baseUrl?: string;
  cache?: TtlCache;
  budget?: Budget;
  breaker?: CircuitBreaker;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class SplitwiseClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly baseUrl: string;
  private readonly cache: TtlCache;
  private readonly budget: Budget;
  private readonly breaker: CircuitBreaker;
  private namespace: Promise<string> | undefined;

  constructor(opts: SplitwiseClientOptions) {
    this.token = opts.token;
    // Bound on purpose. Calling `this.fetchImpl(...)` passes this client as
    // `this`, and workerd rejects that with "Illegal invocation": its global
    // functions check their receiver. Node's fetch does not, so nothing in the
    // test suite can see the difference. See the build log.
    this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
    this.retries = opts.retries ?? 3;
    this.backoffMs = opts.backoffMs ?? 500;
    this.baseUrl = opts.baseUrl ?? SPLITWISE_API;
    this.cache = opts.cache ?? noCache();
    this.budget = opts.budget ?? unlimitedBudget();
    this.breaker = opts.breaker ?? sharedBreaker;
  }

  /** Cache keys are namespaced by a hash of the token, never the token. */
  private ns(): Promise<string> {
    this.namespace ??= tokenHash(this.token);
    return this.namespace;
  }

  private async cacheKey(path: string, query: Record<string, string | number | undefined> | undefined): Promise<string> {
    const parts = Object.entries(query ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${String(v)}`)
      .toSorted();
    return `${await this.ns()}|${path}${parts.length ? `?${parts.join('&')}` : ''}`;
  }

  /** Drop what a group write makes stale. Balances are never cached anyway. */
  async invalidateGroups(groupId?: number): Promise<void> {
    await this.cache.delete(await this.cacheKey('/get_groups', undefined));
    if (groupId !== undefined) await this.cache.delete(await this.cacheKey(`/get_group/${groupId}`, undefined));
  }

  private async request<T>(method: 'GET' | 'POST', path: string, query?: Record<string, string | number | undefined>, body?: unknown): Promise<T> {
    const template = route(path);
    const ttl = method === 'GET' ? (CACHE_TTL[template] ?? 0) : 0;
    const key = ttl > 0 ? await this.cacheKey(path, query) : undefined;
    const span = currentSpan().child(`splitwise ${template}`, SPAN_KIND.client, { 'splitwise.endpoint': template });

    try {
      if (key) {
        const hit = await this.cache.get(key);
        if (hit !== undefined) {
          span.setAttributes({ 'cache.hit': true });
          return JSON.parse(hit) as T;
        }
        span.setAttributes({ 'cache.hit': false });
      }

      this.breaker.assertClosed();
      const allowance = await this.budget.take(1);
      span.setAttributes({ 'budget.remaining': allowance.remaining });
      if (!allowance.ok) {
        span.setAttributes({ 'budget.refused': true });
        throw new OverBudget(allowance.retryAfterMs);
      }

      const url = new URL(`${this.baseUrl}${path}`);
      for (const [k, v] of Object.entries(query ?? {})) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }

      let attempt = 0;
      for (;;) {
        const init: RequestInit = {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
            traceparent: span.traceparent(),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
        };
        if (body !== undefined) init.body = JSON.stringify(body);

        let res: Response;
        try {
          res = await this.fetchImpl(url, init);
        } catch (err) {
          // A transport failure counts against the breaker the same as a 5xx.
          this.breaker.recordFailure();
          throw err;
        }
        span.setAttributes({ 'splitwise.status': res.status, 'splitwise.attempt': attempt + 1 });

        // A revoked token never becomes valid by trying again.
        if (res.status === 401 || res.status === 403) {
          this.breaker.recordSuccess();
          throw new SplitwiseUnauthorized();
        }

        if (res.status === 429 || res.status >= 500) {
          this.breaker.recordFailure();
          if (attempt >= this.retries) {
            throw new SplitwiseError(`Splitwise returned ${res.status} after ${attempt + 1} attempts`, res.status);
          }
          const retryAfter = Number(res.headers.get('retry-after'));
          const delay = retryAfter > 0 ? retryAfter * 1000 : this.backoffMs * 2 ** attempt;
          await sleep(delay);
          attempt += 1;
          continue;
        }

        this.breaker.recordSuccess();
        const text = await res.text();
        let json: unknown = undefined;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          json = text;
        }
        if (!res.ok) {
          const detail = typeof json === 'object' && json !== null && 'error' in json ? String((json as { error: unknown }).error) : res.statusText;
          throw new SplitwiseError(`Splitwise ${res.status}: ${detail}`, res.status, json);
        }
        // Splitwise returns 200 with a non-empty `errors` object on failed writes.
        if (typeof json === 'object' && json !== null && 'errors' in json) {
          const errors = (json as { errors: unknown }).errors;
          if (errors && typeof errors === 'object' && Object.keys(errors as object).length > 0) {
            throw new SplitwiseError(`Splitwise rejected the request: ${JSON.stringify(errors)}`, 200, json);
          }
        }
        if (key && text) await this.cache.put(key, text, ttl);
        return json as T;
      }
    } catch (err) {
      span.recordError(err);
      throw err;
    } finally {
      span.end();
    }
  }

  async currentUser(): Promise<SwCurrentUser> {
    return (await this.request<{ user: SwCurrentUser }>('GET', '/get_current_user')).user;
  }

  async groups(): Promise<SwGroup[]> {
    return (await this.request<{ groups: SwGroup[] }>('GET', '/get_groups')).groups;
  }

  async group(id: number): Promise<SwGroup> {
    return (await this.request<{ group: SwGroup }>('GET', `/get_group/${id}`)).group;
  }

  /**
   * `add_user_to_group` and friends answer 200 with `success: false` when they
   * fail. The generic `errors` check catches most of it, but an empty errors
   * object with success false would slip through, so check it explicitly.
   */
  private assertSuccess(res: { success?: boolean }, what: string): void {
    if (res.success === false) throw new SplitwiseError(`Splitwise refused to ${what}`, 200, res);
  }

  async createGroup(body: SwCreateGroup): Promise<SwGroup> {
    const res = await this.request<{ group: SwGroup }>('POST', '/create_group', undefined, body);
    if (!res.group?.id) throw new SplitwiseError('Splitwise returned no group', 200, res);
    return res.group;
  }

  async addUserToGroup(body: SwAddUserToGroup): Promise<SwUser> {
    const res = await this.request<{ success?: boolean; user: SwUser }>('POST', '/add_user_to_group', undefined, body);
    this.assertSuccess(res, 'add that person to the group');
    return res.user;
  }

  async friends(): Promise<SwFriend[]> {
    return (await this.request<{ friends: SwFriend[] }>('GET', '/get_friends')).friends;
  }

  async expenses(params: {
    group_id?: number;
    friend_id?: number;
    dated_after?: string;
    dated_before?: string;
    updated_after?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<SwExpense[]> {
    return (await this.request<{ expenses: SwExpense[] }>('GET', '/get_expenses', { limit: 100, ...params })).expenses;
  }

  /** Walk pagination until fewer than a page comes back or `max` is reached. */
  async allExpenses(params: { group_id?: number; friend_id?: number; dated_after?: string; updated_after?: string }, max = 500): Promise<SwExpense[]> {
    const out: SwExpense[] = [];
    let offset = 0;
    const limit = 100;
    for (;;) {
      const page = await this.expenses({ ...params, limit, offset });
      out.push(...page);
      if (page.length < limit || out.length >= max) break;
      offset += limit;
    }
    return out.slice(0, max);
  }

  async expense(id: number): Promise<SwExpense> {
    return (await this.request<{ expense: SwExpense }>('GET', `/get_expense/${id}`)).expense;
  }

  async createExpense(body: SwCreateExpenseByShares): Promise<SwExpense> {
    const res = await this.request<{ expenses: SwExpense[] }>('POST', '/create_expense', undefined, body);
    const created = res.expenses[0];
    if (!created) throw new SplitwiseError('Splitwise returned no expense', 200, res);
    return created;
  }

  async updateExpense(id: number, body: Partial<SwCreateExpenseByShares>): Promise<SwExpense> {
    const res = await this.request<{ expenses: SwExpense[] }>('POST', `/update_expense/${id}`, undefined, body);
    const updated = res.expenses[0];
    if (!updated) throw new SplitwiseError('Splitwise returned no expense', 200, res);
    return updated;
  }

  async comments(expenseId: number): Promise<SwComment[]> {
    return (await this.request<{ comments: SwComment[] }>('GET', '/get_comments', { expense_id: expenseId })).comments;
  }

  async createComment(expenseId: number, content: string): Promise<SwComment> {
    return (await this.request<{ comment: SwComment }>('POST', '/create_comment', undefined, { expense_id: expenseId, content })).comment;
  }

  async notifications(params: { updated_after?: string; limit?: number } = {}): Promise<SwNotification[]> {
    return (await this.request<{ notifications: SwNotification[] }>('GET', '/get_notifications', params)).notifications;
  }

  async categories(): Promise<SwCategory[]> {
    return (await this.request<{ categories: SwCategory[] }>('GET', '/get_categories')).categories;
  }

  async currencies(): Promise<SwCurrency[]> {
    return (await this.request<{ currencies: SwCurrency[] }>('GET', '/get_currencies')).currencies;
  }
}
