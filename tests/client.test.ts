import { describe, expect, it } from 'vitest';
import { SplitwiseClient, SplitwiseError } from '../src/splitwise/client.js';

function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json', ...next.headers } });
  }) as typeof fetch;
  return { fn, calls };
}

describe('SplitwiseClient', () => {
  it('sends a bearer token and parses the envelope', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: { groups: [{ id: 1, name: 'Lisbon' }] } }]);
    const c = new SplitwiseClient({ token: 'abc', fetch: fn });
    const groups = await c.groups();
    expect(groups[0]?.name).toBe('Lisbon');
    expect(calls[0]?.url).toBe('https://secure.splitwise.com/api/v3.0/get_groups');
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.Authorization).toBe('Bearer abc');
  });
  it('retries on 429 with backoff', async () => {
    const { fn, calls } = fakeFetch([
      { status: 429, body: {}, headers: { 'retry-after': '0' } },
      { status: 200, body: { friends: [] } },
    ]);
    const c = new SplitwiseClient({ token: 'abc', fetch: fn, backoffMs: 1 });
    expect(await c.friends()).toEqual([]);
    expect(calls).toHaveLength(2);
  });
  it('treats a 200 with errors as a failure', async () => {
    const { fn } = fakeFetch([{ status: 200, body: { expenses: [], errors: { base: ['bad'] } } }]);
    const c = new SplitwiseClient({ token: 'abc', fetch: fn });
    await expect(c.createExpense({ cost: '1.00', description: 'x', group_id: 1 })).rejects.toBeInstanceOf(SplitwiseError);
  });
  it('surfaces 401 as SplitwiseError with status', async () => {
    const { fn } = fakeFetch([{ status: 401, body: { error: 'Invalid API request: you are not logged in' } }]);
    const c = new SplitwiseClient({ token: 'bad', fetch: fn });
    await expect(c.currentUser()).rejects.toMatchObject({ status: 401 });
  });
});
