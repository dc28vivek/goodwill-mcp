import { describe, expect, it, vi } from 'vitest';
import { withSpan } from '../src/obs/context.js';
import { OtlpTracer } from '../src/obs/trace.js';
import { CircuitBreaker, UpstreamDown } from '../src/splitwise/breaker.js';
import { MemoryCache } from '../src/splitwise/cache.js';
import { SplitwiseClient, SplitwiseUnauthorized } from '../src/splitwise/client.js';
import { MemoryBudget, OverBudget } from '../src/store/budget.js';

function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json', ...next.headers } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const groupsBody = { groups: [{ id: 1, name: 'Lisbon' }] };

describe('read-through cache', () => {
  it('serves a repeated group list without a second upstream call', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: groupsBody }]);
    const c = new SplitwiseClient({ token: 'abc', fetch: fn, cache: new MemoryCache() });
    expect((await c.groups())[0]?.name).toBe('Lisbon');
    expect((await c.groups())[0]?.name).toBe('Lisbon');
    expect(calls).toHaveLength(1);
  });

  it('never caches expenses, because a stale balance is a wrong answer', async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: { expenses: [] } },
      { status: 200, body: { expenses: [] } },
    ]);
    const c = new SplitwiseClient({ token: 'abc', fetch: fn, cache: new MemoryCache() });
    await c.expenses({ group_id: 1 });
    await c.expenses({ group_id: 1 });
    expect(calls).toHaveLength(2);
  });

  it('expires an entry once its window passes', async () => {
    let t = 1_000_000;
    const { fn, calls } = fakeFetch([
      { status: 200, body: groupsBody },
      { status: 200, body: groupsBody },
    ]);
    const c = new SplitwiseClient({ token: 'abc', fetch: fn, cache: new MemoryCache(() => t) });
    await c.groups();
    t += 61_000;
    await c.groups();
    expect(calls).toHaveLength(2);
  });

  it('a group write drops the cached list, so the new group is visible at once', async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: groupsBody },
      { status: 200, body: groupsBody },
    ]);
    const c = new SplitwiseClient({ token: 'abc', fetch: fn, cache: new MemoryCache() });
    await c.groups();
    await c.invalidateGroups();
    await c.groups();
    expect(calls).toHaveLength(2);
  });

  it('keeps one account out of another account cache', async () => {
    const cache = new MemoryCache();
    const { fn, calls } = fakeFetch([
      { status: 200, body: groupsBody },
      { status: 200, body: { groups: [{ id: 2, name: 'Deewani' }] } },
    ]);
    const a = new SplitwiseClient({ token: 'token-a', fetch: fn, cache });
    const b = new SplitwiseClient({ token: 'token-b', fetch: fn, cache });
    expect((await a.groups())[0]?.name).toBe('Lisbon');
    expect((await b.groups())[0]?.name).toBe('Deewani');
    expect(calls).toHaveLength(2);
  });

  it('does not put the token in a cache key', async () => {
    const seen: string[] = [];
    const cache = { async get(k: string) { seen.push(k); return undefined; }, async put(k: string) { seen.push(k); }, async delete(k: string) { seen.push(k); } };
    const { fn } = fakeFetch([{ status: 200, body: groupsBody }]);
    await new SplitwiseClient({ token: 'super-secret-token', fetch: fn, cache }).groups();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.join('|')).not.toContain('super-secret-token');
  });
});

describe('revoked access', () => {
  it('turns a 401 into a distinct error and does not retry it', async () => {
    const { fn, calls } = fakeFetch([{ status: 401, body: { error: 'Invalid API request' } }]);
    const c = new SplitwiseClient({ token: 'abc', fetch: fn, backoffMs: 1 });
    await expect(c.groups()).rejects.toBeInstanceOf(SplitwiseUnauthorized);
    expect(calls).toHaveLength(1);
  });

  it('treats a 403 the same way', async () => {
    const { fn } = fakeFetch([{ status: 403, body: {} }]);
    const c = new SplitwiseClient({ token: 'abc', fetch: fn });
    await expect(c.groups()).rejects.toBeInstanceOf(SplitwiseUnauthorized);
  });

  it('does not count a rejected token against the breaker', async () => {
    const breaker = new CircuitBreaker({ threshold: 1 });
    const { fn } = fakeFetch([{ status: 401, body: {} }]);
    const c = new SplitwiseClient({ token: 'abc', fetch: fn, breaker });
    await expect(c.groups()).rejects.toBeInstanceOf(SplitwiseUnauthorized);
    expect(breaker.state).toBe('closed');
  });
});

describe('circuit breaker in the client', () => {
  it('stops calling out once the upstream has failed enough times', async () => {
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 30_000 });
    const { fn, calls } = fakeFetch([
      { status: 503, body: {} },
      { status: 503, body: {} },
    ]);
    const c = new SplitwiseClient({ token: 'abc', fetch: fn, retries: 0, breaker });
    await expect(c.friends()).rejects.toThrow();
    await expect(c.friends()).rejects.toThrow();
    expect(calls).toHaveLength(2);

    await expect(c.friends()).rejects.toBeInstanceOf(UpstreamDown);
    expect(calls).toHaveLength(2);
  });

  it('counts a transport failure as an outage', async () => {
    const breaker = new CircuitBreaker({ threshold: 1 });
    const fn = (async () => {
      throw new TypeError('network error');
    }) as unknown as typeof fetch;
    const c = new SplitwiseClient({ token: 'abc', fetch: fn, retries: 0, breaker });
    await expect(c.friends()).rejects.toBeInstanceOf(TypeError);
    expect(breaker.state).toBe('open');
  });
});

describe('per-user budget', () => {
  it('refuses before reaching the network once the allowance is gone', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: { friends: [] } }]);
    const budget = new MemoryBudget({ capacity: 1, refillPerSecond: 0 });
    const c = new SplitwiseClient({ token: 'abc', fetch: fn, budget });
    await c.friends();
    await expect(c.friends()).rejects.toBeInstanceOf(OverBudget);
    expect(calls).toHaveLength(1);
  });

  it('a cache hit costs nothing', async () => {
    const { fn } = fakeFetch([{ status: 200, body: groupsBody }]);
    const budget = new MemoryBudget({ capacity: 1, refillPerSecond: 0 });
    const c = new SplitwiseClient({ token: 'abc', fetch: fn, cache: new MemoryCache(), budget });
    await c.groups();
    await expect(c.groups()).resolves.toHaveLength(1);
  });
});

describe('upstream spans', () => {
  it('names the route and never the id', async () => {
    const sent: unknown[] = [];
    const collect = (async (_u: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response('{}');
    }) as typeof fetch;
    const tracer = new OtlpTracer({ endpoint: 'https://collector.example', fetch: collect });
    const { fn, calls } = fakeFetch([{ status: 200, body: { group: { id: 987654, name: 'Lisbon' } } }]);
    const c = new SplitwiseClient({ token: 'abc', fetch: fn });

    const root = tracer.startSpan('tool explain_balance');
    await withSpan(root, () => c.group(987654));
    root.end();
    await tracer.flush();

    const body = JSON.stringify(sent[0]);
    expect(body).toContain('/get_group/{id}');
    expect(body).not.toContain('987654');
    expect(body).not.toContain('Lisbon');
    // The upstream call carries the trace so a collector can join both sides.
    expect((calls[0]?.init.headers as Record<string, string>)?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});
