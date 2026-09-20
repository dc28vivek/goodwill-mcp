import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server/build.js';
import { createDeps } from '../src/server/env.js';
import { memoryMetrics } from '../src/server/metrics.js';
import { fakeFetch, makeState, type FakeState } from './fixtures/fakeSplitwise.js';

const STATE_KEY = 'goodwill-test-key-0123456789abcdef0123456789';

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

describe('goodwill server', () => {
  let state: FakeState;
  beforeEach(() => {
    state = makeState();
  });

  it('lists six tools with honest annotations and fixed order', async () => {
    const { client } = await connect(state);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['explain_balance', 'list_expenses', 'read_expense', 'recent_activity', 'overall_balances', 'find_missing_expenses', 'stale_balances', 'settle_plan', 'find_duplicates', 'add_expense', 'update_expense', 'create_group', 'add_to_group', 'split_by_items', 'settle_up']);
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

  it('explains what Priya owes as a statement', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'explain_balance', arguments: { group_id: 100, friend: 'Priya' } });
    const sc = r.structuredContent as { balances: { charged: string; settled: string; remaining: string; direction: string; contributions: unknown[] }[] };
    expect(sc.balances[0]).toMatchObject({ charged: '61.00', settled: '0.00', remaining: '61.00', direction: 'they_owe_you' });
    expect(sc.balances[0]?.contributions).toHaveLength(2);
    const text = String((r.content[0] as { text: string }).text);
    expect(text).toContain('Priya S owes you 61.00 EUR');
    expect(text).toContain('across 2 expenses');
  });

  it('shows charged, paid back and left when someone has settled part of it', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'explain_balance', arguments: { group_id: 100, friend: 'Sam' } });
    const sc = r.structuredContent as { balances: { charged: string; settled: string; remaining: string; payment_count: number }[] };
    expect(sc.balances[0]).toMatchObject({ charged: '69.00', settled: '49.00', remaining: '20.00', payment_count: 1 });
    const text = String((r.content[0] as { text: string }).text);
    // The label says who actually paid, because a payment does not always reduce a debt.
    expect(text).toContain('Sam K paid you');
    expect(text).toContain('in 1 payment');
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
    const clean = await client.callTool({ name: 'find_duplicates', arguments: { group_id: 100 } });
    expect((clean.structuredContent as { clusters: unknown[] }).clusters).toHaveLength(0);
    state.expenses.push({ ...state.expenses[0]!, id: 7777, date: '2026-09-05T21:00:00Z' });
    const dirty = await client.callTool({ name: 'find_duplicates', arguments: { group_id: 100 } });
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

  it('reports the overall position across everyone', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'overall_balances', arguments: {} });
    const sc = r.structuredContent as { positions: { currency: string; owed_to_you: string; you_owe: string; net: string; owed_to_you_by: { person: { name: string } }[] }[] };
    expect(sc.positions[0]).toMatchObject({ currency: 'EUR', owed_to_you: '81.00', you_owe: '0.00', net: '81.00' });
    expect(sc.positions[0]?.owed_to_you_by.map((x) => x.person.name)).toEqual(['Priya S', 'Sam K']);
    expect(String((r.content[0] as { text: string }).text)).toContain('you are owed 81.00');
  });

  it('finds a card charge that is not in Splitwise, and ignores one that is', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({
      name: 'find_missing_expenses',
      arguments: {
        currency: 'EUR',
        group_id: 100,
        transactions: [
          { date: '2026-09-05', amount: '84.00', description: 'CERVEJARIA LISBOA' },
          { date: '2026-09-06', amount: '42.00', description: 'BAR DA VELHA' },
        ],
      },
    });
    const sc = r.structuredContent as { checked: number; already_logged: number; missing: { description: string }[] };
    expect(sc).toMatchObject({ checked: 2, already_logged: 1 });
    expect(sc.missing.map((m) => m.description)).toEqual(['BAR DA VELHA']);
    expect(String((r.content[0] as { text: string }).text)).toContain('1 of 2 transactions are not in Splitwise yet');
  });

  it('says so when the statement is fully logged', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({
      name: 'find_missing_expenses',
      arguments: { currency: 'EUR', group_id: 100, transactions: [{ date: '2026-09-04', amount: '99.00', description: 'AIRBNB PAYMENTS' }] },
    });
    expect((r.structuredContent as { missing: unknown[] }).missing).toEqual([]);
    expect(String((r.content[0] as { text: string }).text)).toContain('already in Splitwise');
  });

  it('records a settlement for the full outstanding balance', async () => {
    const { client, prompts } = await connect(state, true);
    const r = await client.callTool({ name: 'settle_up', arguments: { friend: 'Priya', group_id: 100 } });
    expect(prompts[0]).toContain('Priya S paid you 61.00 EUR');
    expect(prompts[0]).toContain('This closes the balance with Priya S');
    const sc = r.structuredContent as { recorded: boolean; amount: string };
    expect(sc).toMatchObject({ recorded: true, amount: '61.00' });
    const body = state.writes.find((w) => w.path === '/create_expense')?.body as Record<string, unknown>;
    expect(body.payment).toBe(true);
    expect(body.cost).toBe('61.00');
  });

  it('records a partial settlement and says what is left', async () => {
    const { client, prompts } = await connect(state, true);
    await client.callTool({ name: 'settle_up', arguments: { friend: 'Priya', group_id: 100, amount: '20.00', direction: 'they_paid' } });
    expect(prompts[0]).toContain('41.00 EUR would still be open');
  });

  it('refuses to settle with someone who owes nothing', async () => {
    const { client } = await connect(state, true);
    const r = await client.callTool({ name: 'settle_up', arguments: { friend: 'Alex Brown', group_id: 100 } });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('nothing outstanding');
  });

  it('splits a receipt by item, allocating tax and tip proportionally', async () => {
    const { client, prompts } = await connect(state, true);
    const r = await client.callTool({
      name: 'split_by_items',
      arguments: {
        group_id: 100,
        description: 'Dinner at Ramiro',
        currency: 'EUR',
        items: [
          { description: 'Steak', amount: '30.00', shared_by: ['me'] },
          { description: 'Salad', amount: '10.00', shared_by: ['Priya'] },
        ],
        tax: '3.00',
        tip: '5.00',
        total: '48.00',
      },
    });
    expect(prompts[0]).toContain('split by item');
    expect(prompts[0]).toContain('Vivek D: 36.00 EUR');
    expect(prompts[0]).toContain('Priya S: 12.00 EUR');
    const sc = r.structuredContent as { posted: boolean; total: string; breakdown: { person: { name: string }; owes: string }[] };
    expect(sc).toMatchObject({ posted: true, total: '48.00' });
    const body = state.writes.find((w) => w.path === '/create_expense')?.body as Record<string, string | number>;
    expect(body.cost).toBe('48.00');
    expect(Number(body.users__0__owed_share) + Number(body.users__1__owed_share)).toBeCloseTo(48, 2);
  });

  it('refuses a receipt whose lines do not add up, before posting anything', async () => {
    const { client } = await connect(state, true);
    const r = await client.callTool({
      name: 'split_by_items',
      arguments: {
        group_id: 100,
        description: 'Misread receipt',
        currency: 'EUR',
        items: [{ description: 'Steak', amount: '30.00', shared_by: ['me'] }],
        tax: '3.00',
        total: '40.00',
      },
    });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('do not add up');
    expect(state.writes).toHaveLength(0);
  });

  it('rejects an unknown name on a receipt line before doing any maths', async () => {
    const { client } = await connect(state, true);
    const r = await client.callTool({
      name: 'split_by_items',
      arguments: { group_id: 100, description: 'Lunch', currency: 'EUR', items: [{ description: 'Soup', amount: '9.00', shared_by: ['Zed'] }] },
    });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('not a member');
    expect(state.writes).toHaveLength(0);
  });

  it('drops per-person expense lists only when the answer covers too many people', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'explain_balance', arguments: { group_id: 100 } });
    const sc = r.structuredContent as { balances: { contributions: unknown[] }[] };
    // Four counterparties in this group, over the detail limit.
    for (const b of sc.balances) expect(b.contributions).toEqual([]);
    const text = String((r.content[0] as { text: string }).text);
    expect(text).toContain('Ask about one person to see them.');
    expect(text).not.toContain('Dinner at Cervejaria');
  });

  it('keeps the expense list for a small group, because listing them is the explanation', async () => {
    // Trim to two other members, as a couple or a small trip would be.
    state.groups[0]!.members = state.groups[0]!.members.filter((m) => [1, 2, 3].includes(m.id));
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'explain_balance', arguments: { group_id: 100 } });
    const sc = r.structuredContent as { balances: { contributions: { description: string }[] }[] };
    expect(sc.balances[0]?.contributions.length).toBeGreaterThan(0);
    expect(String((r.content[0] as { text: string }).text)).toContain('Dinner at Cervejaria');
  });

  it('shows each expense with its total and what share it was', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'explain_balance', arguments: { group_id: 100, friend: 'Priya' } });
    const sc = r.structuredContent as { balances: { contributions: { description: string; amount: string; total: string; share_percent: number | null }[] }[] };
    const dinner = sc.balances[0]?.contributions.find((c) => c.description.startsWith('Dinner'));
    // 84.00 split three ways: her 28.00 is a third of it.
    expect(dinner).toMatchObject({ amount: '28.00', total: '84.00', share_percent: 33.3 });
    expect(String((r.content[0] as { text: string }).text)).toContain('(33.3% of 84.00)');
  });

  it('leaves the share percentage null for payments, where it means nothing', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'explain_balance', arguments: { group_id: 100, friend: 'Sam' } });
    const sc = r.structuredContent as { balances: { contributions: { kind: string; share_percent: number | null }[] }[] };
    const payment = sc.balances[0]?.contributions.find((c) => c.kind === 'payment');
    expect(payment?.share_percent).toBeNull();
  });

  it('still gives the full expense list when one person is named', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'explain_balance', arguments: { group_id: 100, friend: 'Priya' } });
    const sc = r.structuredContent as { balances: { contributions: unknown[] }[] };
    expect(sc.balances[0]?.contributions).toHaveLength(2);
    expect(String((r.content[0] as { text: string }).text)).toContain('Dinner at Cervejaria');
  });

  it('creates a group, separating known friends from email invitations', async () => {
    const { client, prompts } = await connect(state, true);
    const r = await client.callTool({
      name: 'create_group',
      arguments: { name: 'Goa Trip', group_type: 'trip', members: ['Priya', 'nisha.rao@example.com'] },
    });
    expect(prompts[0]).toContain('Adding, already on Splitwise: Priya S');
    expect(prompts[0]).toContain('Inviting by email (they will receive a real invitation): Nisha Rao <nisha.rao@example.com>');
    const sc = r.structuredContent as { created: boolean; group_id: number; members: { status: string }[] };
    expect(sc.created).toBe(true);
    expect(sc.members.map((m) => m.status)).toEqual(['already_on_splitwise', 'invited']);
    const body = state.writes.find((w) => w.path === '/create_group')?.body as Record<string, unknown>;
    expect(body.name).toBe('Goa Trip');
    expect(body.users__0__user_id).toBe(2);
    expect(body.users__1__email).toBe('nisha.rao@example.com');
  });

  it('refuses to create a group when a name cannot be resolved', async () => {
    const { client } = await connect(state, true);
    const r = await client.callTool({ name: 'create_group', arguments: { name: 'Mystery', members: ['Zed'] } });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('Nothing was created');
    expect(state.writes).toHaveLength(0);
  });

  it('adds people to an existing group and skips those already in it', async () => {
    const { client, prompts } = await connect(state, true);
    const r = await client.callTool({ name: 'add_to_group', arguments: { group_id: 100, members: ['Priya', 'nisha@example.com'] } });
    expect(prompts[0]).toContain('Skipping, already in the group: Priya S');
    expect(prompts[0]).toContain("They will see the group's whole expense history");
    const sc = r.structuredContent as { added: boolean; members: { name: string; status: string }[] };
    expect(sc.added).toBe(true);
    expect(sc.members).toHaveLength(1);
    expect(sc.members[0]?.status).toBe('invited');
  });

  it('says so when everyone named is already in the group', async () => {
    const { client } = await connect(state, true);
    const r = await client.callTool({ name: 'add_to_group', arguments: { group_id: 100, members: ['Priya', 'Sam'] } });
    expect((r.structuredContent as { added: boolean }).added).toBe(false);
    expect(state.writes).toHaveLength(0);
  });

  it('can explain from the last payment, carrying the unpaid remainder forward', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'explain_balance', arguments: { group_id: 100, friend: 'Sam', since: 'last_payment' } });
    const sc = r.structuredContent as { balances: { since: string; brought_forward: string; remaining: string; expense_count: number }[] };
    // Sam was charged 69 and paid 49 on 2026-09-06, and nothing has happened since.
    expect(sc.balances[0]).toMatchObject({ since: 'last_payment', brought_forward: '20.00', remaining: '20.00', expense_count: 0 });
    // An empty window says so once rather than printing the same number twice.
    const text = String((r.content[0] as { text: string }).text);
    expect(text).toContain('Nothing has happened since the payment on 2026-09-06');
    expect(text).toContain('has stood at 20.00 EUR since then');
  });

  it('can explain from a date', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'explain_balance', arguments: { group_id: 100, friend: 'Priya', since: '2026-09-04' } });
    const sc = r.structuredContent as { balances: { since: string; brought_forward: string; remaining: string }[] };
    // The Airbnb on the 4th is carried forward; only the dinner on the 5th is listed.
    expect(sc.balances[0]).toMatchObject({ since: 'date', brought_forward: '33.00', remaining: '61.00' });
  });

  it('reports the same balance whichever window is asked for', async () => {
    const { client } = await connect(state);
    for (const since of ['last_settled', 'last_payment', 'all', '2026-09-04']) {
      const r = await client.callTool({ name: 'explain_balance', arguments: { group_id: 100, friend: 'Sam', since } });
      expect((r.structuredContent as { balances: { remaining: string }[] }).balances[0]?.remaining).toBe('20.00');
    }
  });

  it('rejects a window it does not understand', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'explain_balance', arguments: { group_id: 100, friend: 'Sam', since: 'whenever' } });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('is not a window');
  });

  it('lists what was spent, so the model can judge what counts as rent', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'list_expenses', arguments: { group_id: 100, since: '2026-09-01', until: '2026-09-30' } });
    const sc = r.structuredContent as { returned: number; expenses: { description: string; paid_by: string; your_share: string; split_between: number }[] };
    expect(sc.returned).toBe(3);
    const dinner = sc.expenses.find((e) => e.description.startsWith('Dinner'));
    expect(dinner).toMatchObject({ paid_by: 'Vivek D', your_share: '28.00', split_between: 3 });
    // The signed-in user reads as "you", not as their own name.
    expect(String((r.content[0] as { text: string }).text)).toContain('paid by you, your share 28.00, split 3 ways');
  });

  it('leaves settle-up payments out of spending unless asked', async () => {
    const { client } = await connect(state);
    const without = await client.callTool({ name: 'list_expenses', arguments: { group_id: 100, since: '2026-09-01' } });
    const withPayments = await client.callTool({ name: 'list_expenses', arguments: { group_id: 100, since: '2026-09-01', include_payments: true } });
    expect((without.structuredContent as { returned: number }).returned).toBe(3);
    expect((withPayments.structuredContent as { returned: number }).returned).toBe(4);
  });

  it('narrows on a substring without pretending to understand the word', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'list_expenses', arguments: { group_id: 100, since: '2026-09-01', contains: 'airbnb' } });
    const sc = r.structuredContent as { returned: number; expenses: { description: string }[] };
    expect(sc.returned).toBe(1);
    expect(sc.expenses[0]?.description).toBe('Airbnb');
  });

  it('says plainly when nothing matches, rather than returning an empty list silently', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'list_expenses', arguments: { group_id: 100, since: '2026-09-01', contains: 'rent' } });
    expect((r.structuredContent as { returned: number }).returned).toBe(0);
    expect(String((r.content[0] as { text: string }).text)).toContain('No expenses');
  });


  it('reports a missing expense id usefully', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'read_expense', arguments: { expense_id: 999999 } });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('Use list_expenses');
  });

  it('corrects an amount, rescaling shares and showing before and after', async () => {
    const { client, prompts } = await connect(state, true);
    const dinner = state.expenses.find((e) => e.description.startsWith('Dinner'))!;
    const r = await client.callTool({ name: 'update_expense', arguments: { expense_id: dinner.id, cost: '90.00' } });
    expect(prompts[0]).toContain('which everyone on it can already see');
    expect(prompts[0]).toContain('cost: 84.00 -> 90.00');
    expect(prompts[0]).toContain('Priya S: 28.00 -> 30.00');
    expect(prompts[0]).toContain('This changes what Priya S and Sam K owe');
    const sc = r.structuredContent as { updated: boolean; balance_changes: { to: string }[] };
    expect(sc.updated).toBe(true);
    const body = state.writes.find((w) => w.path === '/update_expense')?.body as Record<string, string | number>;
    expect(body.cost).toBe('90.00');
    const owed = [0, 1, 2].map((i) => Number(body[`users__${i}__owed_share`]));
    expect(owed.reduce((a, b) => a + b, 0)).toBeCloseTo(90, 2);
  });

  it('fixes a typo without touching any share', async () => {
    const { client, prompts } = await connect(state, true);
    const dinner = state.expenses.find((e) => e.description.startsWith('Dinner'))!;
    await client.callTool({ name: 'update_expense', arguments: { expense_id: dinner.id, description: 'Dinner at Cervejaria Ramiro' } });
    expect(prompts[0]).toContain('description: Dinner at Cervejaria -> Dinner at Cervejaria Ramiro');
    expect(prompts[0]).not.toContain('Shares become');
    const body = state.writes.find((w) => w.path === '/update_expense')?.body as Record<string, unknown>;
    expect(body.users__0__user_id).toBeUndefined();
  });

  it('does nothing when the values already match', async () => {
    const { client } = await connect(state, true);
    const dinner = state.expenses.find((e) => e.description.startsWith('Dinner'))!;
    const r = await client.callTool({ name: 'update_expense', arguments: { expense_id: dinner.id, cost: '84.00' } });
    expect((r.structuredContent as { updated: boolean }).updated).toBe(false);
    expect(state.writes).toHaveLength(0);
  });

  it('refuses to change a settle-up payment', async () => {
    const { client } = await connect(state, true);
    const payment = state.expenses.find((e) => e.payment)!;
    const r = await client.callTool({ name: 'update_expense', arguments: { expense_id: payment.id, cost: '10.00' } });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('not an expense');
  });

  it('refuses an empty change', async () => {
    const { client } = await connect(state, true);
    const r = await client.callTool({ name: 'update_expense', arguments: { expense_id: 1001 } });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain('Nothing to change');
  });

  it('does not apply the same correction twice', async () => {
    const { client } = await connect(state, true);
    const dinner = state.expenses.find((e) => e.description.startsWith('Dinner'))!;
    await client.callTool({ name: 'update_expense', arguments: { expense_id: dinner.id, cost: '90.00' } });
    const again = await client.callTool({ name: 'update_expense', arguments: { expense_id: dinner.id, cost: '90.00' } });
    expect((again.structuredContent as { updated: boolean }).updated).toBe(false);
    expect(state.writes.filter((w) => w.path === '/update_expense')).toHaveLength(1);
  });

  it('reports only what involves you, grouped by group, with the HTML stripped', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'recent_activity', arguments: { since: '2026-09-14' } });
    const sc = r.structuredContent as { returned: number; events: { what: string; group: string | null }[] };
    // Two expense events touch this user. A stranger's group change and an
    // unknown event by someone else are left out.
    expect(sc.returned).toBe(4);
    expect(sc.events.some((e) => e.what === 'Priya S. added Dinner at Cervejaria. You owe 28.00 EUR')).toBe(true);
    expect(sc.events[0]?.group).toBe('Lisbon');
    const text = String((r.content[0] as { text: string }).text);
    expect(text).toContain('Lisbon:');
    expect(text).not.toContain('<strong>');
  });

  it('folds an add and delete of the same expense into one line', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'recent_activity', arguments: { since: '2026-09-14' } });
    const sc = r.structuredContent as { events: { what: string; transient: { hours: number } | null }[] };
    const taxi = sc.events.find((e) => e.what.includes('Taxi from airport'));
    expect(taxi?.transient).toMatchObject({ hours: 3 });
    expect(taxi?.what).toContain('removed it 3 hours later, so nothing changed');
    // One line, not an add and a delete.
    expect(sc.events.filter((e) => e.what.includes('Taxi from airport'))).toHaveLength(1);
  });

  it('says what an edit actually changed', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'recent_activity', arguments: { since: '2026-09-14' } });
    const sc = r.structuredContent as { events: { what: string }[] };
    const edit = sc.events.find((e) => e.what.includes('updated'));
    expect(edit?.what).toContain('The cost changed from $89.00 to $99.00');
    // The add of the same expense is not an edit and must not carry the summary.
    const added = sc.events.find((e) => e.what.includes('added Dinner'));
    expect(added?.what).not.toContain('cost changed');
  });

  it('says how many events it left out rather than hiding them silently', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'recent_activity', arguments: { since: '2026-09-14' } });
    expect(String((r.content[0] as { text: string }).text)).toContain('2 other events did not involve you and are not listed.');
  });

  it('shows everything when asked', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'recent_activity', arguments: { since: '2026-09-14', everything: true } });
    const sc = r.structuredContent as { returned: number; events: { what: string; group: string | null; group_id: number | null }[] };
    // Four that involve this user, plus a stranger's group change and an event of an unknown type.
    expect(sc.returned).toBe(6);
    const membership = sc.events.find((e) => e.what.includes('removed'));
    // A group event names its own group, so it is placed without an expense.
    expect(membership).toMatchObject({ group: 'Lisbon', group_id: 100 });
    expect(sc.events.some((e) => e.what === 'A brand new kind of event')).toBe(true);
  });

  it('honours the since date', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'recent_activity', arguments: { since: '2026-09-16' } });
    expect((r.structuredContent as { returned: number }).returned).toBe(4);
  });

  it('can narrow to one group', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'recent_activity', arguments: { since: '2026-09-14', group_id: 100 } });
    const sc = r.structuredContent as { returned: number; events: { group_id: number | null }[] };
    expect(sc.returned).toBe(4);
    for (const e of sc.events) expect(e.group_id).toBe(100);
  });

  it('says plainly when nothing involving you has happened', async () => {
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'recent_activity', arguments: { since: '2026-09-19' } });
    expect((r.structuredContent as { returned: number }).returned).toBe(0);
    expect(String((r.content[0] as { text: string }).text)).toContain('Nothing involving you');
  });


  it('centres the settle plan on you, and says how many payments are not yours', async () => {
    // Give the group a debt between two other members as well as ones involving me.
    state.groups[0]!.members = state.groups[0]!.members.map((m) =>
      m.id === 4 ? { ...m, balance: [{ currency_code: 'EUR', amount: '-10.00' }] } : m.id === 5 ? { ...m, balance: [{ currency_code: 'EUR', amount: '10.00' }] } : m,
    );
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'settle_plan', arguments: { group_id: 100 } });
    const text = String((r.content[0] as { text: string }).text);
    expect(text).toContain('Priya S pays you 61.00 EUR');
    expect(text).not.toContain('pays Vivek D');
    expect(text).toContain('You would receive 81.00 in total.');
    expect(text).toContain('1 other payment between other people is not listed.');
  });

  it('shows the whole group plan when asked for everything', async () => {
    state.groups[0]!.members = state.groups[0]!.members.map((m) =>
      m.id === 4 ? { ...m, balance: [{ currency_code: 'EUR', amount: '-10.00' }] } : m.id === 5 ? { ...m, balance: [{ currency_code: 'EUR', amount: '10.00' }] } : m,
    );
    const { client } = await connect(state);
    const r = await client.callTool({ name: 'settle_plan', arguments: { group_id: 100, everything: true } });
    const text = String((r.content[0] as { text: string }).text);
    expect(text).toContain('Alex Ahuja pays Alex Brown 10.00 EUR');
    expect(text).not.toContain('not listed');
  });

  it('names you as you in a single expense breakdown', async () => {
    const { client } = await connect(state);
    const dinner = state.expenses.find((e) => e.description.startsWith('Dinner'))!;
    const r = await client.callTool({ name: 'read_expense', arguments: { expense_id: dinner.id } });
    const text = String((r.content[0] as { text: string }).text);
    expect(text).toContain('paid by you');
    expect(text).toMatch(/^\s*You\s+paid/m);
  });

  it('leaves a trail comment on an expense it creates', async () => {
    const { client, prompts } = await connect(state, true);
    await client.callTool({ name: 'add_expense', arguments: { group_id: 100, text: 'coffee 10, I paid, split with me, Priya and Sam' } });
    expect(prompts[0]).toContain('It will carry a comment saying Added by Goodwill MCP');
    const comment = state.comments.at(-1);
    expect(comment?.content).toContain('coffee, 10.00 EUR');
    expect(comment?.content.endsWith('Added by Goodwill MCP.')).toBe(true);
  });

  it('says what it corrected in the trail comment', async () => {
    const { client } = await connect(state, true);
    const dinner = state.expenses.find((e) => e.description.startsWith('Dinner'))!;
    await client.callTool({ name: 'update_expense', arguments: { expense_id: dinner.id, cost: '90.00' } });
    const comment = state.comments.at(-1);
    expect(comment?.content).toContain('Corrected: cost 84.00 to 90.00');
    expect(comment?.content.endsWith('Added by Goodwill MCP.')).toBe(true);
  });

  it('signs a recorded payment too', async () => {
    const { client } = await connect(state, true);
    await client.callTool({ name: 'settle_up', arguments: { friend: 'Priya', group_id: 100 } });
    expect(state.comments.at(-1)?.content).toContain('Recorded a payment of 61.00 EUR');
  });

  it('still reports success when the trail comment cannot be posted', async () => {
    const { client } = await connect(state, true);
    // Comments start failing after the expense is created.
    const original = state.comments;
    Object.defineProperty(state, 'comments', {
      get: () => original,
      set: () => {
        throw new Error('comment service down');
      },
      configurable: true,
    });
    const r = await client.callTool({ name: 'add_expense', arguments: { group_id: 100, text: 'tea 5' } });
    expect((r.structuredContent as { posted: boolean }).posted).toBe(true);
  });


  it('reads naturally whichever group type is chosen', async () => {
    const { client, prompts } = await connect(state, 'decline');
    await client.callTool({ name: 'create_group', arguments: { name: 'Goa', group_type: 'trip', members: [] } });
    expect(prompts[0]).toContain('Create a trip group called "Goa"');
    prompts.length = 0;
    // "other" is Splitwise's catch-all, not a description, so the word is dropped.
    await client.callTool({ name: 'create_group', arguments: { name: 'Bits', group_type: 'other', members: [] } });
    expect(prompts[0]).toContain('Create a group called "Bits"');
    expect(prompts[0]).not.toContain('a other');
  });
});
