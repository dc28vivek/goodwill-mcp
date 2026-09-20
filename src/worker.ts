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
import { allowed, isOpen } from './server/access.js';
import { bindingDigest, newBinding, readCookie, safeEqual, signState, verifyState } from './server/authState.js';
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
  SPLITTAB_STATE_KEY: string;
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
const STATE_COOKIE = 'st_state';

/** What travels through Splitwise in the state parameter. */
interface StatePayload {
  req: AuthRequest;
  /** Hash of the binding cookie, so the state only works in the browser that started the flow. */
  bind: string;
}

/**
 * Scoped to /callback so it is never sent anywhere else, and SameSite=Lax so it
 * survives the top-level redirect back from Splitwise. Strict would drop it.
 */
function bindingCookie(value: string, maxAgeSeconds: number): string {
  return `${STATE_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/callback; Max-Age=${maxAgeSeconds}`;
}

/** A redirect that can carry headers. Response.redirect returns an immutable one. */
function redirect(location: string, cookie?: string): Response {
  const headers: Record<string, string> = { location };
  if (cookie) headers['set-cookie'] = cookie;
  return new Response(null, { status: 302, headers });
}

function html(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Splittab</title><body style="font:16px system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">${body}</body>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

/**
 * What a person is agreeing to, shown before they are sent to Splitwise.
 *
 * Splitwise tokens carry no scopes and never expire, so "sign in with
 * Splitwise" understates what is happening by a wide margin. This connector
 * previews every write before making it; showing people what they are handing
 * over, before they hand it over, is the same principle pointed at itself.
 */
function consentPage(origin: string, clientName: string, splitwiseUrl: string): Response {
  return html(
    `<h1>Connect Splittab</h1>
     <p><strong>${clientName}</strong> wants to read and change your Splitwise data through this server.</p>
     <h2 style="font-size:1.05rem;margin-bottom:.3rem">What you are granting</h2>
     <ul style="padding-left:1.1rem;line-height:1.55">
       <li>Splitwise issues access tokens that <strong>carry no scopes and never expire</strong>. There is no read-only version to give.</li>
       <li>This server stores that token encrypted, and uses it only to answer your requests.</li>
       <li>It never deletes anything, and it asks you to confirm every expense, payment or group it creates or changes.</li>
       <li>Anything it adds or edits gets a comment on the expense saying so, visible to everyone on it.</li>
     </ul>
     <h2 style="font-size:1.05rem;margin-bottom:.3rem">Taking it back</h2>
     <p>Revoke at any time in Splitwise under <strong>Settings &gt; Apps</strong>. That kills the token immediately and nothing here can use it again.</p>
     <p style="margin-top:1.5rem">
       <a href="${splitwiseUrl}" style="display:inline-block;background:#1cc29f;color:#fff;padding:.6rem 1.1rem;border-radius:6px;text-decoration:none;font-weight:600">Continue to Splitwise</a>
       <span style="margin-left:1rem;color:#666">or close this tab to cancel</span>
     </p>
     <p style="margin-top:2rem;color:#666;font-size:.9rem">Splittab is an unofficial connector, not affiliated with, endorsed by, or supported by Splitwise, Inc. Source: <a href="https://github.com/dc28vivek/splittab-mcp">github.com/dc28vivek/splittab-mcp</a>. Served from ${origin}.</p>`,
  );
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
      if (url.pathname === '/health') return Response.json({ ok: true, name: 'splittab-mcp' });
      return html(
        `<h1>Splittab</h1><p><strong>An unofficial Splitwise MCP server.</strong> Add <code>${url.origin}/mcp</code> as a custom connector in Claude, then sign in with Splitwise.${isOpen(env) ? '' : ' Access is limited to an allowlist.'}</p>
         <p>Splitting the tab is the easy half. Remembering it, explaining it, and asking for it back is the half that costs you something. This is for that half.</p>
         <h2 style="font-size:1.05rem;margin-bottom:.3rem">Before you connect</h2>
         <p>Splitwise access tokens carry no scopes and never expire, so signing in gives this server full access to your Splitwise account. It is stored encrypted, used only for your own requests, and you can revoke it whenever you like under <strong>Settings &gt; Apps</strong> in Splitwise. Nothing here deletes anything, and every write is previewed and confirmed first.</p>
         <p>If you would rather not hand a token to someone else's server, run it yourself instead: <code>npx -y splittab-mcp</code> with your own API key, and nothing leaves your machine. See <a href="https://github.com/dc28vivek/splittab-mcp">the repository</a>.</p>
         <p style="color:#666;font-size:.9rem">Not affiliated with, endorsed by, or supported by Splitwise, Inc.</p>`,
      );
    }

    if (url.pathname === '/authorize') {
      let authRequest: AuthRequest;
      try {
        authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
      } catch (error) {
        if (!(error instanceof AuthorizationError)) throw error;
        if (!error.redirectUri) return html(`<p>${error.description}</p>`, 400);
        const back = new URL(error.redirectUri);
        back.searchParams.set('error', error.code);
        back.searchParams.set('error_description', error.description);
        if (error.state) back.searchParams.set('state', error.state);
        if (error.issuer) back.searchParams.set('iss', error.issuer);
        return Response.redirect(back.toString(), 302);
      }
      const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
      if (!client) return html('<p>Unknown OAuth client.</p>', 400);

      // The request travels in the signed state parameter. Nothing is stored,
      // so nothing can fail to replicate before the person comes back.
      const binding = newBinding();
      const payload: StatePayload = { req: authRequest, bind: await bindingDigest(binding) };
      const state = await signState(env.SPLITTAB_STATE_KEY, payload, STATE_TTL_SECONDS);

      const to = new URL(SPLITWISE_AUTHORIZE);
      to.searchParams.set('response_type', 'code');
      to.searchParams.set('client_id', env.SPLITWISE_CLIENT_ID);
      to.searchParams.set('redirect_uri', `${url.origin}/callback`);
      to.searchParams.set('state', state);

      // The binding cookie rides on this response, so the consent page has to
      // carry it rather than a bare redirect.
      const page = consentPage(url.origin, client.clientName ?? authRequest.clientId, to.toString());
      page.headers.set('set-cookie', bindingCookie(binding, STATE_TTL_SECONDS));
      return page;
    }

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code || !state) return html('<p>Missing code or state.</p>', 400);
      const verified = await verifyState<StatePayload>(env.SPLITTAB_STATE_KEY, state);
      if (!verified.ok) return html(`<p>${STATE_MESSAGE[verified.reason]}</p>`, 400);
      const { req: authRequest, bind } = verified.payload;

      // The state is self-contained, so signing it proves only that we issued
      // it. The cookie proves this is the same browser that started the flow.
      const binding = readCookie(request.headers.get('cookie'), STATE_COOKIE);
      if (!binding || !bind || !safeEqual(await bindingDigest(binding), bind)) {
        return html('<p>This sign-in was started in a different browser or the link was reused. Start again from your MCP client.</p>', 400);
      }

      const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
      if (!client) return html('<p>Unknown OAuth client.</p>', 400);

      const splitwiseToken = await exchangeCode(env, code, `${url.origin}/callback`);
      const user = await currentUser(splitwiseToken);
      if (!allowed(env, user.email)) {
        const refused = html(`<h1>Not on the list</h1><p>${user.email} is not allowed to use this server. Ask the person who runs it, or revoke access at Splitwise &gt; Settings &gt; Apps.</p>`, 403);
        refused.headers.set('set-cookie', bindingCookie('', 0));
        return refused;
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
      // One use per browser: the binding is spent the moment it succeeds.
      return redirect(redirectTo, bindingCookie('', 0));
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
      stateKey: this.env.SPLITTAB_STATE_KEY,
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
