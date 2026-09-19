#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildServer } from '../server/build.js';
import { createDeps, randomStateKey } from '../server/env.js';
import { MemoryWriteLog } from '../store/writeLog.js';

const token = process.env.SPLITWISE_API_KEY;
if (!token) {
  process.stderr.write('SPLITWISE_API_KEY is not set. Register an app at https://secure.splitwise.com/apps and copy the API key.\n');
  process.exit(2);
}

// One process serves one user, so a per-process key and an in-memory log are fine here.
const stateKey = process.env.FAIRSPLIT_STATE_KEY ?? randomStateKey();
const writeLog = new MemoryWriteLog();
const deps = createDeps({ token, stateKey, writeLog });

serveStdio(() => buildServer(deps));
process.stderr.write('fairsplit-mcp: serving over stdio\n');
