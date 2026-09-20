import { afterEach, describe, expect, it } from 'vitest';
import { OtlpTracer } from '../src/obs/trace.js';
import { SplitwiseClient } from '../src/splitwise/client.js';

/**
 * Cloudflare's runtime checks the receiver of its global functions. Storing
 * the global `fetch` on an object and calling it as `this.fetchImpl(...)`
 * passes that object as `this`, and workerd answers "Illegal invocation:
 * function called with incorrect `this` reference".
 *
 * Node's fetch does not check, so the entire suite passed while every tool
 * call failed in production. These tests put the check back, by standing in a
 * global that rejects a foreign receiver the way workerd does.
 */
const real = globalThis.fetch;

function strictGlobalFetch(): { calls: number } {
  const state = { calls: 0 };
  const impl = function (this: unknown) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
    }
    state.calls += 1;
    return Promise.resolve(new Response(JSON.stringify({ groups: [] }), { headers: { 'content-type': 'application/json' } }));
  };
  globalThis.fetch = impl as unknown as typeof fetch;
  return state;
}

afterEach(() => {
  globalThis.fetch = real;
});

describe('the default fetch survives a runtime that checks its receiver', () => {
  it('SplitwiseClient does not hand itself over as `this`', async () => {
    const state = strictGlobalFetch();
    // No fetch override, so the client falls back to the global.
    await expect(new SplitwiseClient({ token: 'abc' }).groups()).resolves.toEqual([]);
    expect(state.calls).toBe(1);
  });

  it('the tracer does not either', async () => {
    const state = strictGlobalFetch();
    const tracer = new OtlpTracer({ endpoint: 'https://collector.example' });
    tracer.startSpan('x').end();
    await tracer.flush();
    expect(state.calls).toBe(1);
  });
});
