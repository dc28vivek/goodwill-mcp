#!/usr/bin/env node
/**
 * Local Streamable HTTP server for development and conformance runs.
 * Single user: one API key from the environment. Binds to localhost only.
 * The hosted multi-user server lives in src/worker.ts.
 */
import { createServer } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { buildServer } from '../server/build.js';
import { createDeps, randomStateKey } from '../server/env.js';
import { MemoryWriteLog } from '../store/writeLog.js';

const token = process.env.SPLITWISE_API_KEY;
if (!token) {
  process.stderr.write('SPLITWISE_API_KEY is not set.\n');
  process.exit(2);
}
const port = Number(process.env.PORT ?? 3000);
const baseUrl = process.env.SPLITWISE_API_BASE;
const stateKey = process.env.FAIRSPLIT_STATE_KEY ?? randomStateKey();
const writeLog = new MemoryWriteLog();
const deps = createDeps({ token, stateKey, writeLog, ...(baseUrl ? { baseUrl } : {}) });

const handler = createMcpHandler(() => buildServer(deps), {
  onerror: (err) => process.stderr.write(`mcp error: ${err.message}\n`),
});
const nodeHandler = toNodeHandler(handler);
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'fairsplit-mcp' }));
    return;
  }
  if (!validateHost(req, res) || !validateOrigin(req, res)) return;
  // The adapter's request type is stricter than IncomingMessage under
  // exactOptionalPropertyTypes (method is string | undefined here). The
  // runtime shape is the same. See build-log.
  void nodeHandler(req as unknown as Parameters<typeof nodeHandler>[0], res);
}).listen(port, '127.0.0.1', () => {
  process.stderr.write(`fairsplit-mcp: http://127.0.0.1:${port}/mcp\n`);
});
