/**
 * Runs the official MCP conformance suite against the local HTTP server,
 * with the fake Splitwise API behind it. `npm run conformance`.
 *
 * Starts both servers, waits for /health, runs the CLI, then stops them.
 */
import { spawn, type ChildProcess } from 'node:child_process';

const FAKE_PORT = 3999;
const MCP_PORT = 3777;

function start(cmd: string, args: string[], env: Record<string, string>): ChildProcess {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
  return child;
}

async function waitFor(url: string, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404 || res.status === 401) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function main() {
  const extra = process.argv.slice(2);
  const fake = start('npx', ['tsx', 'evals/fake-splitwise-server.ts'], { FAKE_SPLITWISE_PORT: String(FAKE_PORT) });
  const mcp = start('npx', ['tsx', 'src/bin/http.ts'], {
    PORT: String(MCP_PORT),
    SPLITWISE_API_KEY: 'test-token',
    SPLITWISE_API_BASE: `http://127.0.0.1:${FAKE_PORT}/api/v3.0`,
    FAIRSPLIT_STATE_KEY: 'fairsplit-conformance-key-0123456789abcdef',
  });
  const stop = () => {
    fake.kill();
    mcp.kill();
  };
  process.on('exit', stop);
  try {
    await waitFor(`http://127.0.0.1:${FAKE_PORT}/get_currencies`);
    await waitFor(`http://127.0.0.1:${MCP_PORT}/health`);
    const code = await new Promise<number>((resolve) => {
      const run = spawn('npx', ['-y', '@modelcontextprotocol/conformance@0.1.16', 'server', '--url', `http://127.0.0.1:${MCP_PORT}/mcp`, '-o', 'conformance-results', ...extra], {
        stdio: 'inherit',
        env: process.env,
      });
      run.on('exit', (c) => resolve(c ?? 1));
    });
    stop();
    process.exit(code);
  } catch (err) {
    console.error(err);
    stop();
    process.exit(1);
  }
}

void main();
