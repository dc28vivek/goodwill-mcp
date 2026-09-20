/**
 * Cloudflare Worker: the hosted, multi-user server.
 *
 * Roles in one Worker:
 * - OAuth 2.1 authorization server for MCP clients (workers-oauth-provider):
 *   PKCE, refresh rotation, RFC 9728 metadata, Client ID Metadata Documents.
 * - OAuth client to Splitwise: /authorize sends the person to Splitwise,
 *   /callback verifies the signed state and checks the email allowlist.
 * - MCP resource server at /mcp. The provider validates our bearer token and
 *   hands the decrypted props (the Splitwise token, the granted scopes) to the
 *   API handler for that one request.
 *
 * The handshake keeps no server-side state: the pending authorization request
 * is signed into the OAuth state parameter instead of parked in KV, because KV
 * has no read-after-write guarantee and a login returning through a different
 * point of presence would be told its link had expired. See ADR-0015.
 *
 * Per-user state that has to be correct rather than fast lives in one Durable
 * Object per person: the write-log reservation and the upstream budget. See
 * ADR-0016.
 *
 * See docs/SECURITY.md and ADR-0008.
 */
import { AuthorizationError, OAuthProvider, type AuthRequest, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createMcpHandler, hostHeaderValidationResponse, preloadSchemas } from '@modelcontextprotocol/server';
import { OtlpTracer, type Tracer, noopTracer, parseTraceparent } from './obs/trace.js';
import { buildServer, SERVER_INFO } from './server/build.js';
import { signState, verifyState } from './server/authState.js';
import { createDeps } from './server/env.js';
import { WorkersCache } from './splitwise/cache.js';
import { DurableBudget, DurableWriteLog, UserState, userStateStub } from './worker/userState.js';

preloadSchemas();

export { UserState };

export interface Env {
  OAUTH_KV: KVNamespace;
  /** One object per Splitwise user: write-log reservations and upstream budget. */
  USER_STATE: DurableObjectNamespace<UserState>;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Comma-separated emails allowed to connect. Empty means nobody. */
  ALLOWED_EMAILS: string;
  /** Optional. When set, requests with another Host header are refused. */
  PUBLIC_HOST?: string;
  SPLITWISE_CLIENT_ID: string;
  SPLITWISE_CLIENT_SECRET: string;
  /** HMAC key for multi round-trip state and for the OAuth state parameter. At least 32 characters. */
  GOODWILL_STATE_KEY: string;
  /** Optional OTLP collector. With none set, tracing is off and costs nothing. */
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  /** `key=value,key=value`, typically an API key for a hosted collector. */
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  /** Fraction of traces kept, 0 to 1. Failures are always kept. Default 1. */
  OTEL_SAMPLE_RATIO?: string;
  ENVIRONMENT?: string;
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
const STATE_TTL_SECONDS = 600;

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Goodwill</title><body style="font:16px system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">${body}</body>`,
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

function otlpHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return out;
}

function makeTracer(env: Env, request: Request): Tracer {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) return noopTracer();
  const ratio = Number(env.OTEL_SAMPLE_RATIO ?? '1');
  return new OtlpTracer({
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    headers: otlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    serviceName: SERVER_INFO.name,
    serviceVersion: SERVER_INFO.version,
    environment: env.ENVIRONMENT ?? 'production',
    parent: parseTraceparent(request.headers.get('traceparent')),
    sampleRatio: Number.isFinite(ratio) && ratio > 0 ? ratio : 1,
  });
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

const STATE_MESSAGE = {
  malformed: 'That sign-in link was not formed correctly. Start again from your MCP client.',
  bad_signature: 'That sign-in link was not issued by this server. Start again from your MCP client.',
  expired: 'That sign-in link is more than ten minutes old. Start again from your MCP client.',
} as const;

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      if (url.pathname === '/health') return Response.json({ ok: true, name: 'goodwill-mcp' });
      return html(
        `<h1>Goodwill</h1><p><strong>An unofficial Splitwise MCP server.</strong> Add <code>${url.origin}/mcp</code> as a custom connector in Claude, then sign in with Splitwise. Access is limited to an allowlist.</p><p>In accounting, goodwill is the value of a relationship that never appears on the balance sheet. That is what this protects.</p><p>Not affiliated with, endorsed by, or supported by Splitwise, Inc.</p>`,
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

      // The request travels in the signed state parameter. Nothing is stored,
      // so nothing can fail to replicate before the person comes back.
      const state = await signState(env.GOODWILL_STATE_KEY, authRequest, STATE_TTL_SECONDS);

      const to = new URL(SPLITWISE_AUTHORIZE);
      to.searchParams.set('response_type', 'code');
      to.searchParams.set('client_id', env.SPLITWISE_CLIENT_ID);
      to.searchParams.set('redirect_uri', `${url.origin}/callback`);
      to.searchParams.set('state', state);
      return Response.redirect(to.toString(), 302);
    }

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state) return html('<p>Missing code or state.</p>', 400);
      const verified = await verifyState<AuthRequest>(env.GOODWILL_STATE_KEY, state);
      if (!verified.ok) return html(`<p>${STATE_MESSAGE[verified.reason]}</p>`, 400);
      const authRequest = verified.payload;
      const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
      if (!client) return html('<p>Unknown OAuth client.</p>', 400);

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
        metadata: { email: user.email, clientName: client.clientName ?? authRequest.clientId },
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
    const stub = userStateStub(this.env.USER_STATE, props.userId);
    const tracer = makeTracer(this.env, request);
    const deps = createDeps({
      token: props.splitwiseToken,
      stateKey: this.env.GOODWILL_STATE_KEY,
      writeLog: new DurableWriteLog(stub),
      budget: new DurableBudget(stub),
      cache: new WorkersCache(caches.default),
      tracer,
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
      // Spans outlive the response, so the flush must not be tied to it.
      this.ctx.waitUntil(tracer.flush());
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
