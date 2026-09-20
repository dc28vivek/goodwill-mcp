import { createRequestStateCodec } from '@modelcontextprotocol/server';
import { type Tracer, noopTracer } from '../obs/trace.js';
import type { CircuitBreaker } from '../splitwise/breaker.js';
import type { TtlCache } from '../splitwise/cache.js';
import { SplitwiseClient } from '../splitwise/client.js';
import type { Budget } from '../store/budget.js';
import { MemoryWriteLog, type WriteLog } from '../store/writeLog.js';
import { type Deps, type PendingWrite, makeDeps } from './deps.js';
import { type Metrics, stderrMetrics } from './metrics.js';

export interface DepsOptions {
  token: string;
  /** HMAC key for requestState. At least 32 bytes. Shared across instances. */
  stateKey: Uint8Array | string;
  writeLog?: WriteLog;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Test-only override of the Splitwise API base URL. Production always uses the real host. */
  baseUrl?: string;
  metrics?: Metrics;
  /** Read-through cache for the slow-moving endpoints. Off by default. */
  cache?: TtlCache;
  /** Per-user upstream allowance. Unlimited by default. */
  budget?: Budget;
  /** Shared per isolate unless a test supplies its own. */
  breaker?: CircuitBreaker;
  /** Off by default: with no collector configured, tracing costs nothing. */
  tracer?: Tracer;
}

export function createDeps(opts: DepsOptions): Deps {
  const codec = createRequestStateCodec<PendingWrite>({ key: opts.stateKey, ttlSeconds: 600 });
  return makeDeps({
    client: new SplitwiseClient({
      token: opts.token,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.cache ? { cache: opts.cache } : {}),
      ...(opts.budget ? { budget: opts.budget } : {}),
      ...(opts.breaker ? { breaker: opts.breaker } : {}),
    }),
    writeLog: opts.writeLog ?? new MemoryWriteLog(),
    codec,
    now: opts.now ?? (() => new Date()),
    metrics: opts.metrics ?? stderrMetrics(),
    tracer: opts.tracer ?? noopTracer(),
  });
}

/** A random key for single-process use (stdio). Hosted servers must configure one. */
export function randomStateKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}
