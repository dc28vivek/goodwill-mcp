/**
 * Carries the current span across awaits so the Splitwise client can attach
 * child spans without every tool signature growing a span parameter.
 *
 * This is propagation only, not instrumentation. Spans are still opened by
 * hand at the two places worth measuring: one per tool call and one per
 * upstream request. Nothing is captured automatically, which is what keeps the
 * attribute allowlist in trace.ts meaningful.
 *
 * AsyncLocalStorage is native in Node and available on Workers through the
 * nodejs_compat flag, which wrangler.jsonc already sets.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { NOOP_SPAN, type Span } from './trace.js';

const storage = new AsyncLocalStorage<Span>();

export function withSpan<T>(span: Span, fn: () => T): T {
  return storage.run(span, fn);
}

/** The innermost active span, or a span that records nothing. */
export function currentSpan(): Span {
  return storage.getStore() ?? NOOP_SPAN;
}
