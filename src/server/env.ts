import { createRequestStateCodec } from '@modelcontextprotocol/server';
import { SplitwiseClient } from '../splitwise/client.js';
import { MemoryWriteLog, type WriteLog } from '../store/writeLog.js';
import { type Deps, type PendingWrite, makeDeps } from './deps.js';

export interface DepsOptions {
  token: string;
  /** HMAC key for requestState. At least 32 bytes. Shared across instances. */
  stateKey: Uint8Array | string;
  writeLog?: WriteLog;
  fetch?: typeof fetch;
  now?: () => Date;
}

export function createDeps(opts: DepsOptions): Deps {
  const codec = createRequestStateCodec<PendingWrite>({ key: opts.stateKey, ttlSeconds: 600 });
  return makeDeps({
    client: new SplitwiseClient({ token: opts.token, ...(opts.fetch ? { fetch: opts.fetch } : {}) }),
    writeLog: opts.writeLog ?? new MemoryWriteLog(),
    codec,
    now: opts.now ?? (() => new Date()),
  });
}

/** A random key for single-process use (stdio). Hosted servers must configure one. */
export function randomStateKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}
