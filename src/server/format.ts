import type { CallToolResult } from '@modelcontextprotocol/server';
import { withSpan } from '../obs/context.js';
import { SPAN_KIND, type Tracer } from '../obs/trace.js';
import { OverBudget } from '../store/budget.js';
import { UpstreamDown } from '../splitwise/breaker.js';
import { SplitwiseUnauthorized } from '../splitwise/client.js';

/**
 * Text written by other group members (descriptions, comments, names) is
 * data, never instructions. We strip control characters, cap the length, and
 * the server instructions tell the model the same thing. See ADR-0003.
 */
export function untrusted(text: string | null | undefined, max = 200): string {
  if (!text) return '';
  // Stripping control characters is the point here, so the rule is muted.
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}

export function fullName(u: { first_name: string; last_name?: string | null } | null | undefined): string {
  if (!u) return 'Unknown';
  return untrusted([u.first_name, u.last_name].filter(Boolean).join(' '), 60);
}

/** A tool result the model can act on. Text mirrors the structured content. */
export function ok(summary: string, structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: structured,
  };
}

/** A tool execution error with a recovery hint. Never a protocol error. */
export function fail(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export const GROUP_URL = (id: number) => `https://secure.splitwise.com/#/groups/${id}`;

/**
 * Scope tiers for the hosted server: read, add, modify. Over stdio there is
 * no bearer token and every tool is allowed; the API key already grants full
 * access to the person running it. Over HTTP the granted scopes come from the
 * authorization step. Returns an error result when the scope is missing.
 */
export type Scope = 'read' | 'add' | 'modify';

export function missingScope(ctx: { http?: { authInfo?: { scopes: string[] } } | undefined }, scope: Scope): CallToolResult | undefined {
  const auth = ctx.http?.authInfo;
  if (!auth) return undefined;
  if (auth.scopes.includes(scope)) return undefined;
  return fail(`This connection was authorized without the "${scope}" scope. Reconnect and grant it to use this tool.`);
}


/**
 * Turn the three operational failures into a plain answer instead of a stack
 * trace. Each one is a true statement about what to do next, and each carries
 * the trace id, which is the only handle a person has when reporting a fault.
 */
function explain(err: unknown, traceId: string): CallToolResult | undefined {
  const reference = `\n\nReference: ${traceId}`;
  if (err instanceof SplitwiseUnauthorized) {
    return fail(`Splitwise rejected this connection, which usually means access was revoked in Splitwise under Settings > Apps. Sign in again to reconnect.${reference}`);
  }
  if (err instanceof UpstreamDown) {
    return fail(`Splitwise is not responding. This connector stopped retrying so it does not add to the load. Try again in about ${Math.ceil(err.retryAfterMs / 1000)} seconds.${reference}`);
  }
  if (err instanceof OverBudget) {
    return fail(`This account has made a lot of Splitwise requests in a short time, so the connector paused itself. Try again in about ${Math.ceil(err.retryAfterMs / 1000)} seconds.${reference}`);
  }
  return undefined;
}

/**
 * Wrap a tool handler so every call emits one `tool_call` event with duration
 * and whether it produced an error result, and opens one span that every
 * upstream request hangs off. Round 2 is a retry that carries input responses.
 */
export function timed<A, C extends { mcpReq: { inputResponses?: Record<string, unknown> | undefined } }, R extends { isError?: boolean | undefined } | { resultType?: string }>(
  deps: { metrics: { emit(e: { type: 'tool_call'; tool: string; ok: boolean; ms: number; round: 1 | 2 }): void }; tracer: Tracer },
  tool: string,
  fn: (args: A, ctx: C) => Promise<R>,
): (args: A, ctx: C) => Promise<R> {
  return async (args, ctx) => {
    const started = Date.now();
    const round: 1 | 2 = ctx.mcpReq.inputResponses ? 2 : 1;
    const span = deps.tracer.startSpan(`tool ${tool}`, SPAN_KIND.server, { 'mcp.tool': tool, 'mcp.round': round });
    try {
      const result = await withSpan(span, () => fn(args, ctx));
      const isError = 'isError' in result && result.isError === true;
      span.setAttributes({ 'mcp.outcome': isError ? 'error' : 'ok' });
      deps.metrics.emit({ type: 'tool_call', tool, ok: !isError, ms: Date.now() - started, round });
      return result;
    } catch (err) {
      span.recordError(err);
      deps.metrics.emit({ type: 'tool_call', tool, ok: false, ms: Date.now() - started, round });
      const friendly = explain(err, span.traceId);
      // A tool result, not a protocol error, so the model can relay the advice.
      if (friendly) return friendly as unknown as R;
      throw err;
    } finally {
      span.end();
      void deps.tracer.flush();
    }
  };
}

/**
 * Render a person as "you" when they are the signed-in user.
 *
 * The server knows who is asking, so naming them in the third person reads
 * like a report about a stranger. Structured output keeps real names, because
 * a machine reader needs them unambiguous; only prose uses "you".
 */
export function who(user: { id: number; first_name: string; last_name?: string | null } | null | undefined, meId: number): string {
  if (user && user.id === meId) return 'you';
  return fullName(user);
}

/** Capitalise a rendered name for the start of a sentence. */
export function sentenceCase(name: string): string {
  return name === 'you' ? 'You' : name;
}
