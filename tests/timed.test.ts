import { describe, expect, it } from 'vitest';
import { OtlpTracer, noopTracer } from '../src/obs/trace.js';
import { timed } from '../src/server/format.js';
import { UpstreamDown } from '../src/splitwise/breaker.js';
import { SplitwiseUnauthorized } from '../src/splitwise/client.js';
import { memoryMetrics } from '../src/server/metrics.js';
import { OverBudget } from '../src/store/budget.js';

const ctx = { mcpReq: {} } as { mcpReq: { inputResponses?: Record<string, unknown> | undefined } };

function wrap(err: unknown) {
  const metrics = memoryMetrics();
  const deps = { metrics, tracer: new OtlpTracer({ endpoint: 'https://collector.example', fetch: (async () => new Response('{}')) as typeof fetch }) };
  const fn = timed<unknown, typeof ctx, { isError?: boolean | undefined; content?: { text: string }[] }>(deps, 'explain_balance', async () => {
    throw err;
  });
  return { fn, metrics };
}

const textOf = (r: { content?: { text: string }[] }) => r.content?.[0]?.text ?? '';

describe('timed', () => {
  it('turns a revoked token into advice a person can act on', async () => {
    const { fn } = wrap(new SplitwiseUnauthorized());
    const out = await fn({}, ctx);
    expect(out.isError).toBe(true);
    expect(textOf(out)).toContain('Settings > Apps');
    expect(textOf(out)).toMatch(/Reference: [0-9a-f]{32}/);
  });

  it('turns an upstream outage into a wait, with the time to wait', async () => {
    const { fn } = wrap(new UpstreamDown(20_000));
    expect(textOf(await fn({}, ctx))).toContain('about 20 seconds');
  });

  it('turns a spent allowance into a wait', async () => {
    const { fn } = wrap(new OverBudget(3000));
    expect(textOf(await fn({}, ctx))).toContain('about 3 seconds');
  });

  it('still records the call as failed', async () => {
    const { fn, metrics } = wrap(new OverBudget(1000));
    await fn({}, ctx);
    expect(metrics.events).toContainEqual(expect.objectContaining({ type: 'tool_call', tool: 'explain_balance', ok: false }));
  });

  it('lets an unexpected error through rather than guessing at advice', async () => {
    const { fn } = wrap(new RangeError('shares do not sum to the total'));
    await expect(fn({}, ctx)).rejects.toBeInstanceOf(RangeError);
  });

  it('reports round 2 when the call carries a confirmation', async () => {
    const metrics = memoryMetrics();
    const fn = timed<unknown, typeof ctx, { isError?: boolean | undefined }>({ metrics, tracer: noopTracer() }, 'add_expense', async () => ({}));
    await fn({}, { mcpReq: { inputResponses: { confirm: true } } });
    expect(metrics.events).toContainEqual(expect.objectContaining({ type: 'tool_call', round: 2, ok: true }));
  });
});
