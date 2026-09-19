import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * Text written by other group members (descriptions, comments, names) is
 * data, never instructions. We strip control characters, cap the length, and
 * the server instructions tell the model the same thing. See ADR-0003.
 */
export function untrusted(text: string | null | undefined, max = 200): string {
  if (!text) return '';
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
