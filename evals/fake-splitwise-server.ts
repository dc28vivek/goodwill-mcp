/**
 * Serves the fake Splitwise API over HTTP so the stdio or http server can be
 * pointed at it with SPLITWISE_API_BASE. Used by conformance runs and by
 * model-driven evals. Never used in production.
 */
import { createServer } from 'node:http';
import { fakeFetch, makeState } from '../tests/fixtures/fakeSplitwise.js';

const port = Number(process.env.FAKE_SPLITWISE_PORT ?? 3999);
const state = makeState();
const handle = fakeFetch(state);

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k === 'authorization' ? 'Authorization' : k] = v;
  const init: RequestInit = { method: req.method ?? 'GET', headers };
  if (body) init.body = body;
  // The incoming path already carries /api/v3.0 when SPLITWISE_API_BASE points here.
  const out = await handle(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
  res.writeHead(out.status, { 'content-type': 'application/json' });
  res.end(await out.text());
}).listen(port, '127.0.0.1', () => {
  process.stderr.write(`fake splitwise: http://127.0.0.1:${port}/api/v3.0 (token: test-token)\n`);
});
