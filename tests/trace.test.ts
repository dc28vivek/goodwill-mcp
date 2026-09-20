import { describe, expect, it, vi } from 'vitest';
import { OtlpTracer, SPAN_KIND, parseTraceparent } from '../src/obs/trace.js';

function collector() {
  const sent: unknown[] = [];
  const fn = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { fn, sent };
}

function spansOf(payload: unknown): Array<{ name: string; attributes: Array<{ key: string; value: Record<string, unknown> }>; status: { code: number }; parentSpanId?: string; spanId: string; traceId: string }> {
  const p = payload as { resourceSpans: Array<{ scopeSpans: Array<{ spans: never[] }> }> };
  return p.resourceSpans[0]!.scopeSpans[0]!.spans;
}

const base = (fn: typeof fetch) => ({ endpoint: 'https://collector.example', fetch: fn, serviceName: 'splittab-mcp', serviceVersion: '0.1.0' });

describe('OtlpTracer', () => {
  it('appends the traces path and posts OTLP JSON', async () => {
    const c = collector();
    const send = vi.fn(c.fn);
    const t = new OtlpTracer({ ...base(send as typeof fetch) });
    t.startSpan('tool explain_balance', SPAN_KIND.server).end();
    await t.flush();
    expect(send.mock.calls[0]?.[0]).toBe('https://collector.example/v1/traces');
    expect(spansOf(c.sent[0])[0]?.name).toBe('tool explain_balance');
  });

  it('does not append the path twice', async () => {
    const c = collector();
    const send = vi.fn(c.fn);
    const t = new OtlpTracer({ ...base(send as typeof fetch), endpoint: 'https://collector.example/v1/traces' });
    t.startSpan('x').end();
    await t.flush();
    expect(send.mock.calls[0]?.[0]).toBe('https://collector.example/v1/traces');
  });

  it('drops every attribute key outside the allowlist', async () => {
    const c = collector();
    const t = new OtlpTracer(base(c.fn));
    const span = t.startSpan('tool add_expense');
    span.setAttributes({ 'mcp.tool': 'add_expense' });
    // A caller reaching past the type for something that must never be exported.
    (span.setAttributes as (a: Record<string, string>) => void)({ 'expense.description': 'Dinner at Trader Joe', 'group.name': 'Lisbon trip' });
    span.end();
    await t.flush();
    const keys = spansOf(c.sent[0])[0]!.attributes.map((a) => a.key);
    expect(keys).toContain('mcp.tool');
    expect(keys).not.toContain('expense.description');
    expect(keys).not.toContain('group.name');
    expect(JSON.stringify(c.sent[0])).not.toContain('Trader Joe');
    expect(JSON.stringify(c.sent[0])).not.toContain('Lisbon');
  });

  it('reduces an allowed string to a safe alphabet, so free text cannot ride along', async () => {
    const c = collector();
    const t = new OtlpTracer(base(c.fn));
    const span = t.startSpan('x');
    span.setAttributes({ 'mcp.tool': 'rent for flat 3, paid by Janani' });
    span.end();
    await t.flush();
    const value = spansOf(c.sent[0])[0]!.attributes.find((a) => a.key === 'mcp.tool')?.value;
    expect(value).toEqual({ stringValue: 'rent_for_flat_3__paid_by_Janani' });
  });

  it('nests child spans under their parent in one trace', async () => {
    const c = collector();
    const t = new OtlpTracer(base(c.fn));
    const root = t.startSpan('tool explain_balance');
    const child = root.child('splitwise /get_expenses', SPAN_KIND.client, { 'splitwise.endpoint': '/get_expenses' });
    child.end();
    root.end();
    await t.flush();
    const spans = spansOf(c.sent[0]);
    const kid = spans.find((s) => s.name === 'splitwise /get_expenses')!;
    const parent = spans.find((s) => s.name === 'tool explain_balance')!;
    expect(kid.parentSpanId).toBe(parent.spanId);
    expect(kid.traceId).toBe(parent.traceId);
  });

  it('continues an inbound trace', async () => {
    const c = collector();
    const parent = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(parent?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    const t = new OtlpTracer({ ...base(c.fn), parent });
    t.startSpan('x').end();
    await t.flush();
    expect(spansOf(c.sent[0])[0]?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(spansOf(c.sent[0])[0]?.parentSpanId).toBe('00f067aa0ba902b7');
  });

  it('ignores a malformed or all-zero traceparent', () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent('garbage')).toBeUndefined();
    expect(parseTraceparent(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`)).toBeUndefined();
  });

  it('marks a failed span and names only the error class', async () => {
    const c = collector();
    const t = new OtlpTracer(base(c.fn));
    const span = t.startSpan('x');
    span.recordError(new TypeError('connection to 10.0.0.4 refused for user janani@example.com'));
    span.end();
    await t.flush();
    expect(spansOf(c.sent[0])[0]?.status.code).toBe(2);
    expect(JSON.stringify(c.sent[0])).not.toContain('janani@example.com');
    expect(JSON.stringify(c.sent[0])).toContain('TypeError');
  });

  it('drops a sampled-out trace but always keeps a failed one', async () => {
    const quiet = collector();
    const a = new OtlpTracer({ ...base(quiet.fn), sampleRatio: 0 });
    a.startSpan('fine').end();
    await a.flush();
    expect(quiet.sent).toHaveLength(0);

    const loud = collector();
    const b = new OtlpTracer({ ...base(loud.fn), sampleRatio: 0 });
    const span = b.startSpan('broken');
    span.recordError(new Error('nope'));
    span.end();
    await b.flush();
    expect(loud.sent).toHaveLength(1);
  });

  it('flushes finished spans and keeps open ones for later', async () => {
    const c = collector();
    const t = new OtlpTracer(base(c.fn));
    const done = t.startSpan('first');
    const open = t.startSpan('second');
    done.end();
    await t.flush();
    expect(spansOf(c.sent[0]).map((s) => s.name)).toEqual(['first']);

    open.end();
    await t.flush();
    expect(spansOf(c.sent[1]).map((s) => s.name)).toEqual(['second']);
  });

  it('sends nothing when there is nothing finished', async () => {
    const c = collector();
    const t = new OtlpTracer(base(c.fn));
    await t.flush();
    expect(c.sent).toHaveLength(0);
  });

  it('never lets a collector failure reach the caller', async () => {
    const t = new OtlpTracer({
      ...base((() => Promise.reject(new Error('collector down'))) as unknown as typeof fetch),
    });
    t.startSpan('x').end();
    await expect(t.flush()).resolves.toBeUndefined();
  });
});
