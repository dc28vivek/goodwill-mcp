# Runbook

Operating notes for the hosted Cloudflare Worker. For local stdio use, the README is enough.

## What runs where

| Piece | Where | Holds |
|---|---|---|
| MCP endpoint | Worker, `POST /mcp` | Nothing between requests. A fresh server instance per request. |
| Authorization server | Worker, `/authorize`, `/oauth/token`, `/oauth/register` | `@cloudflare/workers-oauth-provider` |
| Token store | `OAUTH_KV` | Access and refresh tokens; Splitwise tokens encrypted inside the grant props |
| Write log, pending logins | `GOODWILL_KV` | Duplicate-write fingerprints (48h TTL), in-flight OAuth handoffs (10m TTL) |

## First deploy

1. Register an app at <https://secure.splitwise.com/apps> with callback `https://<host>/callback`.
2. `npx wrangler kv namespace create OAUTH_KV` and `... create GOODWILL_KV`; paste both ids into `wrangler.jsonc`.
3. `npx wrangler secret put SPLITWISE_CLIENT_ID`, then `SPLITWISE_CLIENT_SECRET`, then `GOODWILL_STATE_KEY` (32+ random characters).
4. Set `ALLOWED_EMAILS` and `PUBLIC_HOST` in `wrangler.jsonc`. An empty allowlist means nobody can connect.
5. `npm run deploy`.
6. Check `https://<host>/health` returns `{"ok":true}` and `npm run smoke:worker` passes locally.

## Health checks

- `GET /health` — liveness. No dependencies, so a 200 means the Worker is up, not that Splitwise is.
- `GET /.well-known/oauth-protected-resource/mcp` — should name `<host>/mcp` as the resource.
- `GET /.well-known/oauth-authorization-server` — should list `read`, `add`, `modify` in `scopes_supported`.
- `POST /mcp` with no token — expect `401` and a `WWW-Authenticate` header containing `resource_metadata`.

## Common failures

**Someone cannot connect, gets 403 after logging in to Splitwise.**
Their Splitwise account email is not in `ALLOWED_EMAILS`. Note that this is their *Splitwise* email, which is usually personal rather than work. Add it and redeploy.

**Everything 500s right after a config change.**
Most likely a missing KV binding. Named wrangler environments do not inherit `kv_namespaces` or `vars`, so an `env.*` block needs its own copy of both. This is why there is no named environment in `wrangler.jsonc`.

**`/authorize` redirects to Splitwise and comes back with an invalid-redirect error.**
The `redirect_uri` is built from the request origin. If the Worker is reached on a hostname other than the one registered with Splitwise, it will not match. Set `PUBLIC_HOST` and reach the Worker on that hostname only.

**A tool returns "this connection was authorized without the modify scope".**
Working as intended. `update_expense` is the only tool needing `modify`, and a connection is granted `read` and `add` unless the client asks for more. The person reconnects and grants it.

**Writes fail with 429.**
Splitwise's rate limits are undocumented and shared across everyone using this deployment's client credentials, because the API has no per-user quota. The client backs off and retries three times. If it persists, the allowlist is too large for one app's credentials; that is the ceiling described in ADR-0008.

**A duplicate expense appeared anyway.**
The write log is keyed per user in `GOODWILL_KV` with a 48-hour TTL. It cannot catch a duplicate created through the Splitwise app or by a different connector. `find_duplicates` will find it; deletion is done in the app.

## Revoking access

Anyone can revoke at **Splitwise > Settings > Apps**, which invalidates their Splitwise token immediately. The connector's own token stays valid until it expires but becomes useless, and the next call fails with a 401.

To revoke from this side, remove the email from `ALLOWED_EMAILS` and redeploy. That stops new logins but does not kill live grants; to do that, delete the grant keys from `OAUTH_KV`.

## Things this server deliberately cannot do

No tool deletes an expense, a group, a member or a comment. If an operator is asked to undo something, the answer is the Splitwise app, not a support action here. See ADR-0004 and ADR-0010.

## Logs and metrics

Structured JSON on the console, captured by Workers Observability. One `tool_call` line per invocation with the tool, whether it errored, duration and round number, plus `preview_shown`, `preview_confirmed`, `preview_declined`, `duplicate_blocked` and `write_posted`. No names, descriptions or amounts are ever logged.
