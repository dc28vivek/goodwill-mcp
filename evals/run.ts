/**
 * Deterministic evals runner. `npm run evals`.
 * Reads evals/scenarios.yaml, runs each against an in-process server with the
 * fake Splitwise API, and prints pass/fail with reasons. Exit code 1 on any failure.
 */
import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { parse } from 'yaml';
import { buildServer } from '../src/server/build.js';
import { createDeps } from '../src/server/env.js';
import { type MetricEvent, memoryMetrics } from '../src/server/metrics.js';
import { fakeFetch, makeState } from '../tests/fixtures/fakeSplitwise.js';

interface Scenario {
  id: string;
  prompt: string;
  tool: string;
  args: Record<string, unknown>;
  answer?: 'accept' | 'decline';
  now?: string;
  expect: Record<string, unknown>;
  note?: string;
}

const STATE_KEY = 'goodwill-evals-key-0123456789abcdef0123456789';

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    if (key === 'length' && Array.isArray(acc)) return acc.length;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

const allEvents: MetricEvent[] = [];

async function runScenario(s: Scenario): Promise<string[]> {
  const failures: string[] = [];
  const state = makeState();
  const metrics = memoryMetrics();
  const now = s.now ? new Date(s.now) : new Date('2026-09-19T12:00:00Z');
  const deps = createDeps({ token: 'test-token', stateKey: STATE_KEY, fetch: fakeFetch(state), now: () => now, metrics });
  const server = buildServer(deps);
  const client = new Client({ name: 'evals', version: '0.0.0' }, { capabilities: { elicitation: { form: {} } } });
  const prompts: string[] = [];
  client.setRequestHandler('elicitation/create', async (req) => {
    prompts.push(String(req.params.message));
    if (s.answer === 'decline') return { action: 'decline' };
    return { action: 'accept', content: { confirm: true } };
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);

  const result = await client.callTool({ name: s.tool, arguments: s.args });
  const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');

  for (const [key, expected] of Object.entries(s.expect)) {
    if (key === 'isError') {
      const actual = Boolean(result.isError);
      if (actual !== expected) failures.push(`isError: expected ${expected}, got ${actual}. text: ${text.slice(0, 160)}`);
    } else if (key === 'text_includes') {
      for (const needle of expected as string[]) if (!text.includes(needle)) failures.push(`text missing "${needle}". text: ${text.slice(0, 200)}`);
    } else if (key === 'prompt_includes') {
      const all = prompts.join('\n');
      for (const needle of expected as string[]) if (!all.includes(needle)) failures.push(`confirmation prompt missing "${needle}". prompts: ${all.slice(0, 200)}`);
    } else if (key.startsWith('structured.')) {
      const actual = getPath(result.structuredContent, key.slice('structured.'.length));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push(`${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    } else if (key.startsWith('writes.')) {
      const path = `/${key.slice('writes.'.length)}`;
      const count = state.writes.filter((w) => w.path === path).length;
      if (count !== expected) failures.push(`${key}: expected ${expected} write(s), got ${count}`);
    } else {
      failures.push(`unknown expectation key ${key}`);
    }
  }
  await client.close();
  await server.close();
  allEvents.push(...metrics.events);
  return failures;
}

async function main() {
  const scenarios = parse(readFileSync(new URL('./scenarios.yaml', import.meta.url), 'utf8')) as Scenario[];
  const only = process.argv[2];
  let failed = 0;
  const started = Date.now();
  for (const s of scenarios) {
    if (only && s.id !== only) continue;
    const failures = await runScenario(s);
    if (failures.length) {
      failed += 1;
      console.log(`FAIL  ${s.id}`);
      for (const f of failures) console.log(`      ${f}`);
    } else {
      console.log(`ok    ${s.id}`);
    }
  }
  const total = only ? 1 : scenarios.length;
  console.log(`\n${total - failed}/${total} passed in ${Date.now() - started}ms`);

  // Product metrics from this run, the same events the server emits in production.
  const count = (t: MetricEvent['type']) => allEvents.filter((e) => e.type === t).length;
  const calls = allEvents.filter((e): e is Extract<MetricEvent, { type: 'tool_call' }> => e.type === 'tool_call');
  const p50 = calls.map((c) => c.ms).toSorted((a, b) => a - b)[Math.floor(calls.length / 2)] ?? 0;
  const shown = count('preview_shown');
  console.log('\nmetrics');
  console.log(`  tool calls            ${calls.length} (p50 ${p50} ms, ${calls.filter((c) => !c.ok).length} error results)`);
  console.log(`  previews shown        ${shown}`);
  console.log(`  preview accept rate   ${shown ? Math.round((count('preview_confirmed') / shown) * 100) : 0}%`);
  console.log(`  duplicates blocked    ${count('duplicate_blocked')}`);
  console.log(`  writes posted         ${count('write_posted')}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
