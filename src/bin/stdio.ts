#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildServer } from '../server/build.js';
import { createDeps, randomStateKey } from '../server/env.js';
import { MemoryCache } from '../splitwise/cache.js';
import { MemoryBudget } from '../store/budget.js';
import { MemoryWriteLog } from '../store/writeLog.js';

const token = process.env.SPLITWISE_API_KEY;
if (!token) {
  process.stderr.write('SPLITWISE_API_KEY is not set. Register an app at https://secure.splitwise.com/apps and copy the API key.\n');
  process.exit(2);
}

// One process serves one user, so a per-process key, log, cache and budget
// are all the coordination this deployment needs.
const stateKey = process.env.SPLITTAB_STATE_KEY ?? randomStateKey();
const writeLog = new MemoryWriteLog();
const baseUrl = process.env.SPLITWISE_API_BASE;
const deps = createDeps({
  token,
  stateKey,
  writeLog,
  cache: new MemoryCache(),
  budget: new MemoryBudget(),
  ...(baseUrl ? { baseUrl } : {}),
});

serveStdio(() => buildServer(deps));
process.stderr.write('splittab-mcp: serving over stdio\n');
