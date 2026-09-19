/**
 * Cloudflare Worker: the hosted, multi-user server.
 *
 * Roles in one Worker:
 * - OAuth 2.1 authorization server for MCP clients (workers-oauth-provider):
 *   PKCE, refresh rotation, RFC 9728 metadata, Client ID Metadata Documents.
 * - OAuth client to Splitwise: /authorize sends the person to Splitwise,
 *   /callback exchanges the code and checks the email allowlist.
 * - MCP resource server at /mcp. The provider validates our bearer token and
 *   hands the decrypted props (the Splitwise token, the granted scopes) to the
 *   API handler for that one request.
 *
 * See docs/SECURITY.md and ADR-0008.
 */
import { AuthorizationError, OAuthProvider, type AuthRequest, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createMcpHandler, hostHeaderValidationResponse, preloadSchemas } from '@modelcontextprotocol/server';
import { buildServer } from './server/build.js';
import { createDeps } from './server/env.js';
import { KvWriteLog } from './store/writeLog.js';

preloadSchemas();

export interface Env {
  OAUTH_KV: KVNamespace;
  FAIRSPLIT_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Comma-separated emails allowed to connect. Empty means nobody. */
  ALLOWED_EMAILS: string;
  /** Optional. When set, requests with another Host header are refused. */
  PUBLIC_HOST?: string;
  SPLITWISE_CLIENT_ID: string;
  SPLITWISE_CLIENT_SECRET: string;
  /** HMAC key for multi round-trip request state. At least 32 characters. */
  FAIRSPLIT_STATE_KEY: string;
}

/** Stored encrypted by the provider, keyed by the access token. */
interface Props {
  splitwiseToken: string;
  userId: number;
  email: string;
  scopes: string[];
  clientId: string;
}

const SCOPES = ['read', 'add', 'modify'] as const;
const DEFAULT_SCOPES = ['read', 'add'];
const SPLITWISE_AUTHORIZE = 'https://secure.splitwise.com/oauth/authorize';
const SPLITWISE_TOKEN = 'https://secure.splitwise.com/oauth/token';
const SPLITWISE_ME = 'https://secure.splitwise.com/api/v3.0/get_current_user';
const PENDING_TTL_SECONDS = 600;

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Fairsplit</title><body style="font:16px system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">${body}</body>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

function allowed(env: Env, email: string): boolean {
  const list = (env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}

function grantedScopes(requested: string[]): string[] {
  const supported = new Set<string>(SCOPES);
  const granted = requested.filter((s) => supported.has(s));
  return granted.length ? granted : DEFAULT_SCOPES;
}

async function exchangeCode(env: Env, code: string, redirectUri: string): Promise<string> {
  const res = await fetch(SPLITWISE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: env.SPLITWISE_CLIENT_ID,
      client_secret: env.SPLITWISE_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Splitwise token exchange failed: ${res.status}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('Splitwise token exchange returned no access_token');
  return json.access_token;
}

async function currentUser(token: string): Promise<{ id: number; email: string; first_name: string }> {
  const res = await fetch(SPLITWISE_ME, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  if (!res.ok) throw new Error(`Splitwise get_current_user failed: ${res.status}`);
  const json = (await res.json()) as { user: { id: number; email: string; first_name: string } };
  return json.user;
}

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      if (url.pathname === '/health') return Response.json({ ok: true, name: 'fairsplit-mcp' });
      return html(
        `<h1>Fairsplit</h1><p>An unofficial Splitwise connector for AI agents. Add <code>${url.origin}/mcp</code> as a custom connector in Claude. Access is limited to an allowlist.</p><p>Not affiliated with Splitwise, Inc.</p>`,
      );
    }

    if (url.pathname === '/authorize') {
      let authRequest: AuthRequest;
      try {
        authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch (error) {
        if (!(error instanceof AuthorizationError)) throw error;
        if (!error.redirectUri) return html(`<p>${error.description}</p>`, 400);
        const redirect = new URL(error.redirectUri);
        redirect.searchParams.set('error', error.code);
        redirect.searchParams.set('error_description', error.description);
        if (error.state) redirect.searchParams.set('state', error.state);
        if (error.issuer) redirect.searchParams.set('iss', error.issuer);
        return Response.redirect(redirect.toString(), 302);
      }
      const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
      if (!client) return html('<p>Unknown OAuth client.</p>', 400);

      const nonce = crypto.randomUUID();
      await env.FAIRSPLIT_KV.put(`pending|${nonce}`, JSON.stringify({ authRequest, clientName: client.clientName ?? authRequest.clientId }), { expirationTtl: PENDING_TTL_SECONDS });

      const to = new URL(SPLITWISE_AUTHORIZE);
      to.searchParams.set('response_type', 'code');
      to.searchParams.set('client_id', env.SPLITWISE_CLIENT_ID);
      to.searchParams.set('redirect_uri', `${url.origin}/callback`);
      to.searchParams.set('state', nonce);
      return Response.redirect(to.toString(), 302);
    }

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const nonce = url.searchParams.get('state');
      if (!code || !nonce) return html('<p>Missing code or state.</p>', 400);
      const raw = await env.FAIRSPLIT_KV.get(`pending|${nonce}`);
      if (!raw) return html('<p>This login link expired. Start again from your MCP client.</p>', 400);
      await env.FAIRSPLIT_KV.delete(`pending|${nonce}`);
      const { authRequest, clientName } = JSON.parse(raw) as { authRequest: AuthRequest; clientName: string };

      const splitwiseToken = await exchangeCode(env, code, `${url.origin}/callback`);
      const user = await currentUser(splitwiseToken);
      if (!allowed(env, user.email)) {
        return html(`<h1>Not on the list</h1><p>${user.email} is not allowed to use this server. Ask the person who runs it, or revoke access at Splitwise &gt; Settings &gt; Apps.</p>`, 403);
      }

      const scopes = grantedScopes(authRequest.scope);
      const props: Props = { splitwiseToken, userId: user.id, email: user.email, scopes, clientId: authRequest.clientId };
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: authRequest,
        userId: String(user.id),
        metadata: { email: user.email, clientName },
        scope: scopes,
        props,
      });
      return Response.redirect(redirectTo, 302);
    }

    return html('<p>Not found.</p>', 404);
  },
};

/** Serves /mcp for requests that carry a valid access token. */
export class McpApi extends WorkerEntrypoint<Env, Props> {
  override async fetch(request: Request): Promise<Response> {
    if (this.env.PUBLIC_HOST) {
      const rejected = hostHeaderValidationResponse(request, [this.env.PUBLIC_HOST]);
      if (rejected) return rejected;
    }
    const props = this.ctx.props;
    const deps = createDeps({
      token: props.splitwiseToken,
      stateKey: this.env.FAIRSPLIT_STATE_KEY,
      writeLog: new KvWriteLog(this.env.FAIRSPLIT_KV),
    });
    const handler = createMcpHandler(() => buildServer(deps));
    try {
      return await handler.fetch(request, {
        authInfo: {
          // The provider already validated the bearer token. Tools only read scopes.
          token: 'validated-by-oauth-provider',
          clientId: props.clientId,
          scopes: props.scopes,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          extra: { email: props.email, userId: props.userId },
        },
      });
    } finally {
      await handler.close();
    }
  }
}

export default new OAuthProvider<Env>({
  apiRoute: '/mcp',
  apiHandler: McpApi,
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  // Preferred for clients with no prior relationship (MCP 2026-07-28).
  clientIdMetadataDocumentEnabled: true,
  // Fallback for older clients. DCR is deprecated but still common.
  clientRegistrationEndpoint: '/oauth/register',
  scopesSupported: [...SCOPES],
  accessTokenTTL: 3600,
});
