import type { CallToolResult } from '@modelcontextprotocol/server';

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
 * Wrap a tool handler so every call emits one `tool_call` event with duration
 * and whether it produced an error result. Round 2 is a retry that carries
 * input responses.
 */
export function timed<A, C extends { mcpReq: { inputResponses?: Record<string, unknown> | undefined } }, R extends { isError?: boolean | undefined } | { resultType?: string }>(
  metrics: { emit(e: { type: 'tool_call'; tool: string; ok: boolean; ms: number; round: 1 | 2 }): void },
  tool: string,
  fn: (args: A, ctx: C) => Promise<R>,
): (args: A, ctx: C) => Promise<R> {
  return async (args, ctx) => {
    const started = Date.now();
    const round: 1 | 2 = ctx.mcpReq.inputResponses ? 2 : 1;
    try {
      const result = await fn(args, ctx);
      const isError = 'isError' in result && result.isError === true;
      metrics.emit({ type: 'tool_call', tool, ok: !isError, ms: Date.now() - started, round });
      return result;
    } catch (err) {
      metrics.emit({ type: 'tool_call', tool, ok: false, ms: Date.now() - started, round });
      throw err;
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
