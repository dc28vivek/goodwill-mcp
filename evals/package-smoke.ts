/**
 * Publish smoke test. `npm run smoke:package`.
 *
 * Packs the tarball, installs it into a throwaway directory as a stranger
 * would, starts the fake Splitwise API, and drives the INSTALLED binary over
 * stdio with a real MCP client. This is the only test that exercises the
 * artifact people actually download.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const FAKE_PORT = 3997;
const repo = process.cwd();

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function main() {
  const checks: [string, boolean, string][] = [];
  const dir = mkdtempSync(join(tmpdir(), 'goodwill-pkg-'));
  const fake = spawn('npx', ['tsx', 'evals/fake-splitwise-server.ts'], { cwd: repo, env: { ...process.env, FAKE_SPLITWISE_PORT: String(FAKE_PORT) }, stdio: 'ignore' });
  const cleanup = () => {
    fake.kill();
    rmSync(dir, { recursive: true, force: true });
  };
  process.on('exit', cleanup);

  try {
    console.log('packing...');
    const tarball = execFileSync('npm', ['pack', '--silent'], { cwd: repo, encoding: 'utf8' }).trim().split('\n').pop()!;
    console.log(`installing ${tarball} into ${dir}`);
    execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund', join(repo, tarball)], { cwd: dir, stdio: 'ignore' });

    await waitFor(`http://127.0.0.1:${FAKE_PORT}/get_currencies`);

    const bin = join(dir, 'node_modules', '.bin', 'goodwill-mcp');
    const client = new Client({ name: 'package-smoke', version: '0.0.0' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler('elicitation/create', async () => ({ action: 'decline' as const }));
    const transport = new StdioClientTransport({
      command: bin,
      env: {
        PATH: process.env.PATH ?? '',
        SPLITWISE_API_KEY: 'test-token',
        SPLITWISE_API_BASE: `http://127.0.0.1:${FAKE_PORT}/api/v3.0`,
        GOODWILL_STATE_KEY: 'goodwill-package-smoke-key-0123456789abcdef',
      },
    });
    await client.connect(transport);

    const info = client.getServerVersion();
    checks.push(['server identifies itself', info?.name === 'goodwill-mcp', `name=${info?.name}`]);

    const { tools } = await client.listTools();
    checks.push(['fourteen tools listed', tools.length === 14, tools.map((t) => t.name).join(', ')]);

    const res = await client.callTool({ name: 'explain_balance', arguments: { group_id: 100, friend: 'Priya' } });
    const b = (res.structuredContent as { balances?: { charged?: string; remaining?: string }[] })?.balances?.[0];
    checks.push(['explain_balance returns a statement', b?.charged === '61.00' && b?.remaining === '61.00', `charged=${b?.charged} remaining=${b?.remaining}`]);

    const resource = await client.readResource({ uri: 'splitwise://groups' });
    const text = resource.contents[0] && 'text' in resource.contents[0] ? String(resource.contents[0].text) : '';
    checks.push(['groups resource served', text.includes('Lisbon'), `${text.slice(0, 40)}...`]);

    const write = await client.callTool({ name: 'add_expense', arguments: { group_id: 100, text: 'coffee 10' } });
    checks.push(['declined write posts nothing', (write.structuredContent as { posted?: boolean })?.posted === false, 'confirmation declined']);

    await client.close();
  } catch (err) {
    checks.push(['ran without throwing', false, (err as Error).message]);
  }

  for (const [name, ok, detail] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}  (${detail})`);
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} package checks passed`);
  cleanup();
  process.exit(failed ? 1 : 0);
}

void main();
