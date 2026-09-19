/**
 * Model-driven evals. `npm run evals:model`.
 *
 * For each scenario marked `model: true`, runs the Claude Code CLI in print
 * mode with this server attached over stdio (against the fake Splitwise API)
 * and checks that the model picked the expected tool with the expected
 * arguments. This measures the part the deterministic run cannot: tool
 * selection from a plain sentence. Uses Haiku to keep cost low.
 *
 * Requires the `claude` CLI to be installed and logged in.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

interface Scenario {
  id: string;
  prompt: string;
  tool: string;
  args: Record<string, unknown>;
  model?: boolean;
  model_args_include?: Record<string, unknown>;
  /** If no fairsplit tool is called, pass when the final answer includes all of these. */
  model_accept_final_includes?: string[];
}

const FAKE_PORT = 3998;
const MODEL = process.env.EVAL_MODEL ?? 'haiku';

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('fake splitwise did not start');
}

interface Run {
  toolCalls: { name: string; input: Record<string, unknown> }[];
  allTools: string[];
  final: string;
  exit: number;
  stderr: string;
}

function runClaude(prompt: string, mcpConfig: string): Promise<Run> {
  return new Promise((resolve) => {
    const args = [
      '-p',
      `${prompt}\n\nUse the fairsplit tools. Answer in two sentences.`,
      '--mcp-config',
      mcpConfig,
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__fairsplit__*',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '10',
      '--model',
      MODEL,
    ];
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const child = spawn('claude', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('exit', (code) => {
      const toolCalls: Run['toolCalls'] = [];
      const allTools: string[] = [];
      let final = '';
      for (const line of out.split('\n').filter(Boolean)) {
        try {
          const j = JSON.parse(line) as { type: string; message?: { content?: { type: string; name?: string; input?: Record<string, unknown> }[] }; result?: string };
          if (j.type === 'assistant')
            for (const b of j.message?.content ?? []) {
              if (b.type !== 'tool_use' || !b.name) continue;
              allTools.push(b.name);
              if (b.name.startsWith('mcp__fairsplit__')) toolCalls.push({ name: b.name.replace('mcp__fairsplit__', ''), input: b.input ?? {} });
            }
          if (j.type === 'result') final = j.result ?? '';
        } catch {
          // non-JSON line
        }
      }
      resolve({ toolCalls, allTools, final, exit: code ?? 1, stderr: err });
    });
  });
}

function includes(actual: Record<string, unknown>, expected: Record<string, unknown>): string[] {
  const misses: string[] = [];
  for (const [k, v] of Object.entries(expected)) {
    const a = actual[k];
    const same = typeof v === 'string' && typeof a === 'string' ? a.toLowerCase().includes(v.toLowerCase()) : JSON.stringify(a) === JSON.stringify(v);
    if (!same) misses.push(`${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(a)}`);
  }
  return misses;
}

async function main() {
  const scenarios = (parse(readFileSync(new URL('./scenarios.yaml', import.meta.url), 'utf8')) as Scenario[]).filter((s) => s.model);
  const only = process.argv[2];
  const dir = mkdtempSync(join(tmpdir(), 'fairsplit-model-'));
  const mcpConfig = join(dir, 'mcp.json');
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        fairsplit: {
          command: 'npx',
          args: ['tsx', join(process.cwd(), 'src/bin/stdio.ts')],
          env: {
            SPLITWISE_API_KEY: 'test-token',
            SPLITWISE_API_BASE: `http://127.0.0.1:${FAKE_PORT}/api/v3.0`,
            FAIRSPLIT_STATE_KEY: 'fairsplit-modelrun-key-0123456789abcdef0123456789',
          },
        },
      },
    }),
  );
  const fake = spawn('npx', ['tsx', 'evals/fake-splitwise-server.ts'], { env: { ...process.env, FAKE_SPLITWISE_PORT: String(FAKE_PORT) }, stdio: ['ignore', 'ignore', 'ignore'] });
  process.on('exit', () => fake.kill());
  await waitFor(`http://127.0.0.1:${FAKE_PORT}/get_currencies`);

  let failed = 0;
  const started = Date.now();
  for (const s of scenarios) {
    if (only && s.id !== only) continue;
    const t0 = Date.now();
    const run = await runClaude(s.prompt, mcpConfig);
    const first = run.toolCalls[0];
    const problems: string[] = [];
    const finalOk = (s.model_accept_final_includes ?? []).length > 0 && s.model_accept_final_includes!.every((w) => run.final.toLowerCase().includes(w.toLowerCase()));
    if (!first && finalOk) {
      // The model asked the person instead of calling the tool. Accepted outcome.
    } else if (!first) problems.push(`no fairsplit tool was called. tools seen: ${run.allTools.join(', ') || 'none'}. exit ${run.exit}. final: ${run.final.slice(0, 160)}`);
    else {
      if (first.name !== s.tool) problems.push(`first tool was ${first.name}, expected ${s.tool}`);
      problems.push(...includes(first.input, s.model_args_include ?? s.args));
    }
    if (problems.length) {
      failed += 1;
      console.log(`FAIL  ${s.id}  (${Date.now() - t0} ms)`);
      for (const p of problems) console.log(`      ${p}`);
      if (run.stderr) console.log(`      stderr: ${run.stderr.slice(0, 200)}`);
    } else {
      console.log(`ok    ${s.id}  ${first ? `${first.name} ${JSON.stringify(first.input)}` : 'asked the person instead'}  (${Date.now() - t0} ms)`);
    }
  }
  const total = only ? 1 : scenarios.length;
  console.log(`\n${total - failed}/${total} model scenarios passed in ${Math.round((Date.now() - started) / 1000)}s with ${MODEL}`);
  fake.kill();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
