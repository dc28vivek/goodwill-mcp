# Runbook

Operating notes for the hosted Cloudflare Worker. For local stdio use, the README is enough.

## What runs where

| Piece | Where | Holds |
|---|---|---|
| MCP endpoint | Worker, `POST /mcp` | Nothing between requests. A fresh server instance per request. |
| Authorization server | Worker, `/authorize`, `/oauth/token`, `/oauth/register` | `@cloudflare/workers-oauth-provider` |
| Token store | `OAUTH_KV` | Access and refresh tokens; Splitwise tokens encrypted inside the grant props |
| Per-user state | `USER_STATE` Durable Object, one per Splitwise user id | Write-log reservations and completed writes (48h), upstream token bucket |
| Pending logins | Nothing | The authorization request is signed into the OAuth `state` parameter, so no store is involved (ADR-0015) |
| Read cache | Cloudflare Cache API, per colo | `get_current_user`, `get_groups`, `get_group/{id}`, `get_friends` for 60s; categories and currencies for a day |

## First deploy

1. Register an app at <https://secure.splitwise.com/apps> with callback `https://<host>/callback`.
2. `npx wrangler kv namespace create OAUTH_KV`; paste the id into `wrangler.jsonc`. The Durable Object needs nothing beyond the migration already in that file.
3. `npx wrangler secret put SPLITWISE_CLIENT_ID`, then `SPLITWISE_CLIENT_SECRET`, then `SPLITTAB_STATE_KEY` (32+ random characters).
   `SPLITTAB_STATE_KEY` now signs the OAuth state parameter as well as multi round-trip confirmations. Rotating it invalidates logins in flight, which is ten minutes of inconvenience, not a data loss.
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
Their Splitwise account email is not in `ALLOWED_EMAILS`. Note that this is their *Splitwise* email, which is usually personal rather than work. Add it and set the secret again.

## Who may connect

`ALLOWED_EMAILS` is a secret, not a var, because it holds real people's addresses and the repository is public. It takes three forms:

| Value | Who gets in |
|---|---|
| empty | nobody, and this is what an unconfigured deployment does |
| `a@b.com, @splitwise.com` | those addresses, plus everyone at a listed domain |
| `*` | anyone who finds the URL |

Opening it is an explicit `*` rather than an empty value, so clearing the config by accident locks the door instead of removing it. Set it with `npx wrangler secret put ALLOWED_EMAILS`, then `npm run deploy`.

**Before setting `*`, understand what you are taking on.** A Splitwise token carries no scopes and never expires, so every person who signs in leaves you holding permanent full access to their account, and you cannot revoke it from this side. Only they can, under Settings > Apps. That is why `/authorize` shows a consent page saying so before anyone is sent to Splitwise. Turn on two-factor authentication for the Cloudflare account that owns this Worker; that account is the realistic path to those tokens, not Cloudflare itself.

**Everything 500s right after a config change.**
Most likely a missing binding. Named wrangler environments do not inherit `kv_namespaces`, `durable_objects` or `vars`, so an `env.*` block needs its own copy of each. This is why there is no named environment in `wrangler.jsonc`.

**`/authorize` redirects to Splitwise and comes back with an invalid-redirect error.**
The `redirect_uri` is built from the request origin. If the Worker is reached on a hostname other than the one registered with Splitwise, it will not match. Set `PUBLIC_HOST` and reach the Worker on that hostname only.

**A tool returns "this connection was authorized without the modify scope".**
Working as intended. `update_expense` is the only tool needing `modify`, and a connection is granted `read` and `add` unless the client asks for more. The person reconnects and grants it.

**Writes fail with 429.**
Splitwise's rate limits are undocumented and shared across everyone using this deployment's client credentials, because the API has no per-user quota. The client backs off and retries three times. If it persists, the allowlist is too large for one app's credentials; that is the ceiling described in ADR-0008.

**A tool answers "this account has made a lot of Splitwise requests in a short time".**
The per-user token bucket refused the call (ADR-0017). It holds 150 requests of burst and refills at 90 a minute, so a person asking questions never sees it and a looping agent does. The message names the wait. If real users hit it, raise `DEFAULT_BUCKET` in `src/store/budget.ts`; do not remove it.

**A tool answers "Splitwise is not responding" without appearing to try.**
The circuit breaker is open (ADR-0017). Five consecutive upstream failures open it for 30 seconds, doubling to a five-minute cap while the trial request keeps failing. This is deliberate: retrying from every request at once is what turns a Splitwise blip into a Splitwise outage. It closes itself on the first success.

**A tool answers "Splitwise rejected this connection".**
Their Splitwise token was revoked at **Settings > Apps**. Splitwise tokens do not expire, so a 401 means revocation and never staleness. The connector stops retrying and asks them to sign in again.

**A duplicate expense appeared anyway.**
The write log lives in that user's Durable Object with a 48-hour window. A second attempt inside the window is refused, and one arriving while the first is still posting is told it is in flight. What the log cannot catch is a duplicate created through the Splitwise app or by a different connector. `find_duplicates` will find it; deletion is done in the app.

**Someone is told their sign-in link expired.**
Now it means what it says. The authorization request is signed into the state parameter with a ten-minute life, so the three failures are distinguishable and the page names the right one: malformed, not issued by this server, or genuinely older than ten minutes. Before ADR-0015 this message was also what a KV replication miss looked like.

## Revoking access

Anyone can revoke at **Splitwise > Settings > Apps**, which invalidates their Splitwise token immediately. The connector's own token stays valid until it expires but becomes useless, and the next call fails with a 401.

To revoke from this side, remove the email from `ALLOWED_EMAILS` and redeploy. That stops new logins but does not kill live grants; to do that, delete the grant keys from `OAUTH_KV`.

A Splitwise token is non-expiring and scopeless, so a compromise of `OAUTH_KV` is total and permanent until every grant is deleted. There is no partial answer. The procedure is: delete every `grant:*` key from `OAUTH_KV`, rotate `SPLITWISE_CLIENT_SECRET` at <https://secure.splitwise.com/apps>, rotate `SPLITTAB_STATE_KEY`, redeploy, and tell everyone on the allowlist to revoke the app at **Settings > Apps** themselves, because only they can invalidate the upstream token.

## Things this server deliberately cannot do

No tool deletes an expense, a group, a member or a comment. If an operator is asked to undo something, the answer is the Splitwise app, not a support action here. See ADR-0004 and ADR-0010.

## Logs and metrics

Structured JSON on the console, captured by Workers Observability. One `tool_call` line per invocation with the tool, whether it errored, duration and round number, plus `preview_shown`, `preview_confirmed`, `preview_declined`, `duplicate_blocked` and `write_posted`. No names, descriptions or amounts are ever logged.
