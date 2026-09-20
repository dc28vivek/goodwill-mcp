/**
 * Exercises every WRITE tool against the real Splitwise API, inside a throwaway
 * group containing only the signed-in user. `npm run sweep`.
 *
 * Nothing touches an existing group, so nobody else sees anything. The group it
 * creates is left behind on purpose: this connector cannot delete, so cleaning
 * up is a deliberate act in the app.
 *
 * Confirmations are auto-accepted here. That tests the mechanics of the
 * round-trip, not the human judgement it exists for; do one add_expense by hand
 * in a real client to check the preview reads well when you are the one saying
 * yes.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildServer } from '../src/server/build.js';
import { createDeps } from '../src/server/env.js';
import { noopMetrics } from '../src/server/metrics.js';

const token = process.env.SPLITWISE_API_KEY;
if (!token) {
  console.error('SPLITWISE_API_KEY is not set.');
  process.exit(2);
}

const prompts: string[] = [];
let answer: 'accept' | 'decline' = 'accept';
const checks: [string, boolean, string][] = [];

function check(name: string, ok: boolean, detail = '') {
  checks.push([name, ok, detail]);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function main() {
  const deps = createDeps({ token: token as string, stateKey: 'goodwill-sweep-key-0123456789abcdef0123456789', metrics: noopMetrics() });
  const server = buildServer(deps);
  const client = new Client({ name: 'goodwill-sweep', version: '0.0.0' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler('elicitation/create', async (req) => {
    prompts.push(String(req.params.message));
    return answer === 'decline' ? { action: 'decline' } : { action: 'accept', content: { confirm: true } };
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);

  const call = async (name: string, args: Record<string, unknown>) => {
    prompts.length = 0;
    const r = await client.callTool({ name, arguments: args });
    return { r, text: r.content.map((c) => ('text' in c ? c.text : '')).join('\n'), sc: r.structuredContent as Record<string, unknown>, prompt: prompts[0] ?? '' };
  };

  const me = await deps.me();
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  console.log(`Signed in as ${me.first_name}. Creating a sandbox group.\n`);

  // 1. create_group, just me.
  const created = await call('create_group', { name: `Goodwill sandbox ${stamp}`, group_type: 'other', members: [] });
  const groupId = Number(created.sc?.group_id);
  check('create_group', created.sc?.created === true && Number.isFinite(groupId), `group ${groupId}`);
  check('  preview said it would create it', /Create a group called/.test(created.prompt), created.prompt.slice(0, 60));
  if (!Number.isFinite(groupId)) {
    console.log('\nCannot continue without a group.');
    process.exit(1);
  }

  // 2. add_expense.
  const added = await call('add_expense', { group_id: groupId, text: 'Sandbox coffee 4.20', idempotency_key: `sweep-${stamp}-1` });
  const expenseId = Number(added.sc?.expense_id);
  check('add_expense', added.sc?.posted === true, `expense ${expenseId}, ${String(added.sc?.cost)}`);
  check('  preview named the split and the signature', /Split:/.test(added.prompt) && /Added by Goodwill MCP/.test(added.prompt));

  // 3. the same expense again: the write log should refuse it.
  const dupe = await call('add_expense', { group_id: groupId, text: 'Sandbox coffee 4.20' });
  check('add_expense refuses a duplicate', dupe.sc?.posted === false, String(dupe.sc?.note ?? '').slice(0, 60));

  // 4. a declined write posts nothing.
  answer = 'decline';
  const declined = await call('add_expense', { group_id: groupId, text: 'Should never exist 99' });
  check('declining posts nothing', declined.sc?.posted === false);
  answer = 'accept';

  // 5. update_expense.
  const updated = await call('update_expense', { expense_id: expenseId, cost: '6.30' });
  check('update_expense', updated.sc?.updated === true, `changes: ${JSON.stringify(updated.sc?.changes ?? [])}`);
  check('  preview showed before and after', /4\.20 -> 6\.30/.test(updated.prompt), updated.prompt.split('\n')[1] ?? '');

  // 6. the trail comments actually landed.
  const read = await call('read_expense', { expense_id: expenseId });
  const comments = (read.sc?.expense as { comments?: { text: string }[] } | undefined)?.comments ?? [];
  const signed = comments.filter((c) => c.text.includes('Added by Goodwill MCP'));
  check('trail comments posted', signed.length >= 2, `${signed.length} signed of ${comments.length}`);

  // 7. split_by_items with a deliberately wrong total.
  const bad = await call('split_by_items', {
    group_id: groupId,
    description: 'Sandbox receipt',
    currency: String(me.default_currency ?? 'USD'),
    items: [{ description: 'Thing', amount: '10.00', shared_by: ['me'] }],
    tax: '1.00',
    total: '20.00',
  });
  check('split_by_items refuses a receipt that does not add up', bad.r.isError === true, bad.text.slice(0, 70));

  // 8. split_by_items that does add up.
  const good = await call('split_by_items', {
    group_id: groupId,
    description: 'Sandbox receipt',
    currency: String(me.default_currency ?? 'USD'),
    items: [{ description: 'Thing', amount: '10.00', shared_by: ['me'] }],
    tax: '1.00',
    total: '11.00',
  });
  check('split_by_items posts a valid receipt', good.sc?.posted === true, String(good.sc?.total ?? ''));

  // 9. the writes are visible to the read tools.
  const listed = await call('list_expenses', { group_id: groupId, since: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) });
  check('writes are visible to list_expenses', Number(listed.sc?.returned) >= 2, `${String(listed.sc?.returned)} expenses`);

  await client.close();
  await server.close();

  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed.`);
  console.log(`Sandbox group ${groupId} is left behind; delete it in the Splitwise app when you are done.`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nSweep failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
