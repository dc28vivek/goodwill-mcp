/**
 * Boots the Worker locally with `wrangler dev` and checks the OAuth plumbing:
 * health, protected-resource metadata, authorization-server metadata, and a
 * 401 challenge on /mcp without a token. `npm run smoke:worker`.
 */
import { spawn } from 'node:child_process';

const PORT = 8787;
const base = `http://127.0.0.1:${PORT}`;

async function waitFor(url: string, tries = 600): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function check(name: string, fn: () => Promise<boolean | string>): Promise<boolean> {
  try {
    const r = await fn();
    const okk = r === true;
    console.log(`${okk ? 'ok  ' : 'FAIL'}  ${name}${typeof r === 'string' ? `  (${r})` : ''}`);
    return okk;
  } catch (err) {
    console.log(`FAIL  ${name}  (${(err as Error).message})`);
    return false;
  }
}

async function main() {
  const dev = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let log = '';
  dev.stdout?.on('data', (d) => (log += String(d)));
  dev.stderr?.on('data', (d) => (log += String(d)));
  const stop = () => dev.kill('SIGTERM');
  process.on('exit', stop);
  try {
    await waitFor(`${base}/health`);
    const results: boolean[] = [];
    results.push(await check('GET /health', async () => (await fetch(`${base}/health`)).status === 200));
    results.push(
      await check('GET /.well-known/oauth-protected-resource/mcp', async () => {
        const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
        if (res.status !== 200) return `status ${res.status}`;
        const j = (await res.json()) as { resource?: string; authorization_servers?: string[] };
        // The provider generates this document from the request origin. It carries no
        // scopes_supported; clients read scopes from the authorization-server metadata.
        return j.resource === `${base}/mcp` && (j.authorization_servers ?? []).includes(base) ? true : JSON.stringify(j);
      }),
    );
    results.push(
      await check('GET /.well-known/oauth-authorization-server', async () => {
        const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
        if (res.status !== 200) return `status ${res.status}`;
        const j = (await res.json()) as { authorization_endpoint?: string; token_endpoint?: string; scopes_supported?: string[]; code_challenge_methods_supported?: string[] };
        const good = j.authorization_endpoint === `${base}/authorize` && j.token_endpoint === `${base}/oauth/token` && (j.code_challenge_methods_supported ?? []).includes('S256') && (j.scopes_supported ?? []).includes('add');
        return good ? true : JSON.stringify(j);
      }),
    );
    results.push(
      await check('POST /mcp without token is 401 with a Bearer challenge', async () => {
        const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
        const www = res.headers.get('www-authenticate') ?? '';
        return res.status === 401 && /Bearer/.test(www) && /resource_metadata/.test(www) ? true : `status ${res.status}, WWW-Authenticate: ${www}`;
      }),
    );
    results.push(
      await check('GET /authorize with an unknown client is rejected', async () => {
        const res = await fetch(`${base}/authorize?client_id=nobody&redirect_uri=https://example.com/cb&response_type=code&code_challenge=abc&code_challenge_method=S256`, { redirect: 'manual' });
        return res.status === 400 || res.status === 302 ? true : `status ${res.status}`;
      }),
    );
    stop();
    const failed = results.filter((r) => !r).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    if (failed) console.log(log.slice(-2000));
    process.exit(failed ? 1 : 0);
  } catch (err) {
    console.error(err);
    console.log(log.slice(-3000));
    stop();
    process.exit(1);
  }
}

void main();
