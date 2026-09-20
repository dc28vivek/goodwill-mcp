/**
 * First contact with a real Splitwise account. `npm run doctor`.
 *
 * Runs every READ-ONLY tool against the live API through a real MCP client and
 * reports what came back. No write tool is registered on the client's allow
 * list here, and none is called: nothing is added, changed or deleted.
 *
 * Everything up to now has run against a fake API with tidy data. This is the
 * first time the code meets real group shapes, real currencies, real member
 * lists, deleted users, multi-currency groups and Splitwise's actual rate
 * limits. Output contains your real names and amounts, so do not paste it
 * anywhere public.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildServer } from '../src/server/build.js';
import { createDeps } from '../src/server/env.js';
import { noopMetrics } from '../src/server/metrics.js';

const READ_ONLY = new Set([
  'explain_balance',
  'list_expenses',
  'read_expense',
  'recent_activity',
  'overall_balances',
  'find_missing_expenses',
  'stale_balances',
  'settle_plan',
  'find_duplicates',
]);

const token = process.env.SPLITWISE_API_KEY;
if (!token) {
  console.error('SPLITWISE_API_KEY is not set.\nGet one at https://secure.splitwise.com/apps, then:\n\n  SPLITWISE_API_KEY=your-key npm run doctor\n');
  process.exit(2);
}

function truncate(text: string, lines = 14): string {
  const all = text.split('\n');
  return all.length <= lines ? text : `${all.slice(0, lines).join('\n')}\n  ... ${all.length - lines} more lines`;
}

async function main() {
  const deps = createDeps({ token: token as string, stateKey: 'splittab-doctor-key-0123456789abcdef0123456789', metrics: noopMetrics() });
  const server = buildServer(deps);
  const client = new Client({ name: 'splittab-doctor', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);

  let failures = 0;
  const run = async (label: string, name: string, args: Record<string, unknown>) => {
    if (!READ_ONLY.has(name)) throw new Error(`refusing to call non-read tool ${name}`);
    const started = Date.now();
    try {
      const r = await client.callTool({ name, arguments: args });
      const text = r.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      const ms = Date.now() - started;
      if (r.isError) {
        failures += 1;
        console.log(`\nFAIL  ${label}  (${ms} ms)\n  ${text.split('\n').join('\n  ')}`);
      } else {
        console.log(`\nok    ${label}  (${ms} ms)\n  ${truncate(text).split('\n').join('\n  ')}`);
      }
    } catch (err) {
      failures += 1;
      console.log(`\nTHREW ${label}\n  ${(err as Error).message}`);
    }
  };

  console.log('Connecting to Splitwise...');
  const me = await deps.me();
  console.log(`Signed in as ${me.first_name} ${me.last_name ?? ''} (id ${me.id}, default currency ${me.default_currency}).`);

  const groups = await deps.client.groups();
  const real = groups.filter((g) => g.id !== 0);
  console.log(`\n${real.length} groups: ${real.map((g) => `${g.name} [${g.group_type}, ${g.members.length} members, id ${g.id}]`).join(', ') || '(none)'}`);

  const currencies = new Set<string>();
  for (const g of real) for (const m of g.members) for (const b of m.balance) currencies.add(b.currency_code);
  console.log(`Currencies in play: ${[...currencies].join(', ') || '(none)'}`);
  const multi = real.filter((g) => new Set(g.members.flatMap((m) => m.balance.map((b) => b.currency_code))).size > 1);
  if (multi.length) console.log(`Multi-currency groups (worth checking closely): ${multi.map((g) => g.name).join(', ')}`);
  const pending = real.flatMap((g) => g.members.filter((m) => m.registration_status !== 'confirmed').map((m) => `${m.first_name} in ${g.name}`));
  if (pending.length) console.log(`Members who have not joined yet: ${pending.join(', ')}`);

  await run('overall_balances', 'overall_balances', {});
  await run('recent_activity (14 days)', 'recent_activity', { since: new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10) });
  await run('stale_balances (30 days)', 'stale_balances', { older_than_days: 30 });

  // A group id or name fragment can be passed: `npm run doctor -- 34196144`.
  // Otherwise the busiest group by member count, then by most recent activity.
  const pick = process.argv[2];
  const target = pick
    ? real.find((g) => String(g.id) === pick || g.name.toLowerCase().includes(pick.toLowerCase()))
    : real.toSorted((a, b) => b.members.length - a.members.length || b.updated_at.localeCompare(a.updated_at))[0];
  if (pick && !target) {
    console.log(`\nNo group matching "${pick}".`);
  }
  if (target) {
    console.log(`\n--- drilling into "${target.name}" (id ${target.id}) ---`);
    await run(`explain_balance (whole group)`, 'explain_balance', { group_id: target.id });
    await run(`settle_plan`, 'settle_plan', { group_id: target.id });
    await run(`find_duplicates (365 days)`, 'find_duplicates', { group_id: target.id, since_days: 365 });
    await run(`list_expenses (90 days)`, 'list_expenses', { group_id: target.id });
    const other = target.members.find((m) => m.id !== me.id);
    if (other) {
      await run(`explain_balance (one person)`, 'explain_balance', { group_id: target.id, friend: String(other.id) });
      await run(`explain_balance (since last payment)`, 'explain_balance', { group_id: target.id, friend: String(other.id), since: 'last_payment' });
    }
    // Read one real expense in full, whichever the listing surfaced first.
    const recent = (await deps.client.allExpenses({ group_id: target.id }, 20)).find((e) => !e.deleted_at);
    if (recent) await run(`read_expense (#${recent.id})`, 'read_expense', { expense_id: recent.id });
    await run('find_missing_expenses (invented charge)', 'find_missing_expenses', {
      group_id: target.id,
      currency: me.default_currency ?? 'USD',
      transactions: [{ date: new Date().toISOString().slice(0, 10), amount: '13.37', description: 'A CHARGE THAT DOES NOT EXIST' }],
    });
  } else {
    console.log('\nNo groups to drill into. Create one in Splitwise and run this again.');
  }

  await client.close();
  await server.close();
  console.log(`\n${failures === 0 ? 'No failures.' : `${failures} failure(s) above.`} Nothing was written to your account.`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('\nDoctor could not run:', err instanceof Error ? err.message : err);
  process.exit(1);
});
