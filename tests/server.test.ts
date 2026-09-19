import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server/build.js';
import { createDeps } from '../src/server/env.js';
import { memoryMetrics } from '../src/server/metrics.js';
import { fakeFetch, makeState, type FakeState } from './fixtures/fakeSplitwise.js';

const STATE_KEY = 'fairsplit-test-key-0123456789abcdef0123456789';

async function connect(state: FakeState, answer: boolean | 'decline' = true) {
  const metrics = memoryMetrics();
  const deps = createDeps({ token: 'test-token', stateKey: STATE_KEY, fetch: fakeFetch(state), now: () => new Date('2026-09-19T12:00:00Z'), metrics });
  const server = buildServer(deps);
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: { elicitation: { form: {} } } });
  const prompts: string[] = [];
  client.setRequestHandler('elicitation/create', async (req) => {
    prompts.push(String(req.params.message));
    if (answer === 'decline') return { action: 'decline' };
    return { action: 'accept', content: { confirm: answer } };
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server, prompts, deps, metrics };
}

describe('fairsplit server', () => {
  let state: FakeState;
  beforeEach(() => {
    state = makeState();
  });

  it('lists six tools with honest annotations and fixed order', async () => {
    const { client } = await connect(state);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['explain_balance', 'stale_balances', 'settle_plan', 'reconcile', 'add_expense', 'nudge']);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.explain_balance?.annotations?.readOnlyHint).toBe(true);
    expect(byName.add_expense?.annotations?.readOnlyHint).toBe(false);
    expect(byName.add_expense?.annotations?.destructiveHint).toBe(false);
    for (const t of tools) expect(t.outputSchema).toBeDefined();
  });

  it('serves the groups resource trimmed', async () => {
    const { client } = await connect(state);
    const res = await client.readResource({ uri: 'splitwise://groups' });
    const text = res.contents[0] && 'text' in res.contents[0] ? res.contents[0].text : '';
    const groups = JSON.parse(String(text));
    expect(groups[0]).toMatchObject({ id: 100, name: 'Lisbon', type: 'trip' });
    expect(groups[0].members).toHaveLength(5);
  });

  it('explains what Priya owes', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'explain_balance', arguments: { group_id: 100, friend: 'Priya' } });
    const sc = r.structuredContent as { balances: { net: string; direction: string; contributions: unknown[] }[] };
    expect(sc.balances[0]).toMatchObject({ net: '61.00', direction: 'they_owe_you' });
    expect(sc.balances[0]?.contributions).toHaveLength(2);
    expect(String((r.content[0] as { text: string }).text)).toContain('Priya S owes you 61.00 EUR');
  });

  it('refuses an ambiguous name with a helpful error', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'explain_balance', arguments: { group_id: 100, friend: 'Alex' } });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('matches 2 people');
  });

  it('plans a settle-up that matches Splitwise', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'settle_plan', arguments: { group_id: 100 } });
    const sc = r.structuredContent as { plans: { payments: { from: { name: string }; to: { name: string }; amount: string }[]; matches_splitwise: boolean }[] };
    expect(sc.plans[0]?.payments).toEqual([
      { from: { id: 2, name: 'Priya S' }, to: { id: 1, name: 'Vivek D' }, amount: '61.00' },
      { from: { id: 3, name: 'Sam K' }, to: { id: 1, name: 'Vivek D' }, amount: '20.00' },
    ]);
    expect(sc.plans[0]?.matches_splitwise).toBe(true);
  });

  it('finds no duplicates in a clean group and one after a double post', async () => {
    const { client } = await connect(state);
    const clean = await client.callTool({ name: 'reconcile', arguments: { group_id: 100 } });
    expect((clean.structuredContent as { clusters: unknown[] }).clusters).toHaveLength(0);
    state.expenses.push({ ...state.expenses[0]!, id: 7777, date: '2026-09-05T21:00:00Z' });
    const dirty = await client.callTool({ name: 'reconcile', arguments: { group_id: 100 } });
    const sc = dirty.structuredContent as { clusters: { suspect: { expense_id: number }; keep: { expense_id: number } }[] };
    expect(sc.clusters).toHaveLength(1);
    expect(sc.clusters[0]?.suspect.expense_id).toBe(7777);
  });

  it('adds an expense after confirmation with exact shares', async () => {
    const { client, prompts } = await connect(state, true);
    const r = await client.callTool({ name: 'add_expense', arguments: { group_id: 100, text: 'coffee 10, I paid, split with me, Priya and Sam' } });
    expect(r.isError).toBeFalsy();
    expect(prompts[0]).toContain('Add "coffee" for 10.00 EUR to Lisbon');
    expect(prompts[0]).toContain('This changes what Priya S and Sam K owe');
    const sc = r.structuredContent as { posted: boolean; expense_id: number };
    expect(sc.posted).toBe(true);
    const body = state.writes[0]?.body as Record<string, string | number>;
    expect(body.cost).toBe('10.00');
    expect(body.users__0__paid_share).toBe('10.00');
    // 10.00 / 3 = 3.33, 3.33, 3.34 with the remainder on the payer.
    const owed = [body.users__0__owed_share, body.users__1__owed_share, body.users__2__owed_share].map(Number);
    expect(owed.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 2);
    expect(body.users__0__owed_share).toBe('3.34');
  });

  it('does not post when the user declines', async () => {
    const { client } = await connect(state, 'decline');
    const r = await client.callTool({ name: 'add_expense', arguments: { group_id: 100, text: 'coffee 10' } });
    expect((r.structuredContent as { posted: boolean }).posted).toBe(false);
    expect(state.writes).toHaveLength(0);
  });

  it('refuses to post the same expense twice', async () => {
    const { client } = await connect(state, true);
    await client.callTool({ name: 'add_expense', arguments: { group_id: 100, text: 'coffee 10' } });
    const again = await client.callTool({ name: 'add_expense', arguments: { group_id: 100, text: 'Coffee 10.00' } });
    expect((again.structuredContent as { posted: boolean; note: string }).posted).toBe(false);
    expect(state.writes.filter((w) => w.path === '/create_expense')).toHaveLength(1);
  });

  it('warns about a likely duplicate already in Splitwise', async () => {
    const { client, prompts } = await connect(state, 'decline');
    await client.callTool({ name: 'add_expense', arguments: { group_id: 100, description: 'Dinner Cervejaria', cost: '84.00', date: '2026-09-05' } });
    expect(prompts[0]).toContain('Possible duplicate');
  });

  it('asks for what is missing', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'add_expense', arguments: { group_id: 100, text: 'lunch with Sam' } });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('cost');
  });

  it('nudges with a drafted comment after confirmation', async () => {
    const { client, prompts } = await connect(state, true);
    const r = await client.callTool({ name: 'nudge', arguments: { friend: 'Priya', group_id: 100, tone: 'plain' } });
    expect(prompts[0]).toContain('you owe 61.00 EUR for Lisbon');
    expect((r.structuredContent as { posted: boolean }).posted).toBe(true);
    expect(state.comments[0]?.content).toContain('Priya');
  });

  it('will not nudge someone who owes nothing', async () => {
    const { client } = await connect(state, true);
    const r = await client.callTool({ name: 'nudge', arguments: { friend: 'Alex Brown', group_id: 100 } });
    expect(r.isError).toBe(true);
  });

  it('emits product metrics for a confirmed write', async () => {
    const { client, metrics } = await connect(state, true);
    await client.callTool({ name: 'add_expense', arguments: { group_id: 100, text: 'coffee 10' } });
    const types = metrics.events.map((e) => e.type);
    expect(types).toContain('preview_shown');
    expect(types).toContain('preview_confirmed');
    expect(types).toContain('write_posted');
    const calls = metrics.events.filter((e) => e.type === 'tool_call');
    expect(calls.map((c) => (c as { round: number }).round)).toEqual([1, 2]);
  });
});
