# Goodwill

**An unofficial Splitwise MCP server.** Ask why you owe what you owe, settle up a trip, add an expense in a sentence, and remind someone without the awkwardness. Every write shows who it affects and waits for your yes. Nothing is ever deleted.

> In accounting, goodwill is the value of a relationship that never appears on the balance sheet. That is what a shared-expense app is actually protecting. The ledger is in service of the goodwill, not the other way round.

Built as a product and engineering showcase. Not affiliated with Splitwise, Inc.

**Status:** v1 built. Six tools, three resources, one prompt. Runs over stdio for local use and as a Cloudflare Worker with OAuth for hosted use. 56 tests, 14 deterministic evals, 7 model-driven evals, the official MCP conformance suite against a documented baseline, and a local Worker smoke test all pass. Not yet deployed against a real Splitwise app; that needs the registered client id and secret.

## What this is

Splitwise is where friends, roommates, couples, and trip groups keep track of who owes whom. This project connects Splitwise to AI agents through the Model Context Protocol so a person can say "settle my Lisbon trip" and have it happen safely.

Thirty people have already built unofficial Splitwise MCP servers. None of them are usable by a normal person, and none treat writes as what they are in Splitwise: a change to other people's money. This project builds the slice that proves a better design and documents what an official connector should be.

## The six tools

| Tool | What it does | Writes? |
|---|---|---|
| `explain_balance` | The number and the expenses behind it | no |
| `stale_balances` | Who is late, by how long | no |
| `settle_plan` | Minimum payments to close a group, checked against Splitwise | no |
| `find_duplicates` | Likely duplicate expenses with a confidence and a suggested action | no |
| `add_expense` | A sentence or fields, a preview naming who is affected, then a confirmed post | after confirmation |
| `nudge` | A drafted reminder in a chosen tone, posted as a comment after confirmation | after confirmation |

Every write goes through the 2026-07-28 multi round-trip pattern: the tool returns `input_required` with a preview, the client asks the person, and the write happens only on a confirmed retry. A per-user write log refuses duplicate posts for 48 hours. Nothing is ever deleted.

Resources: `splitwise://groups`, `splitwise://categories`, `splitwise://currencies`. Prompt: `close_out_trip`.

## Run it locally (stdio)

1. Register an app at https://secure.splitwise.com/apps and copy the API key.
2. `npm install`
3. Add to Claude Code:

```bash
claude mcp add goodwill -e SPLITWISE_API_KEY=your-key -- npx tsx /path/to/goodwill-mcp/src/bin/stdio.ts
```

Or in Claude Desktop's config:

```json
{
  "mcpServers": {
    "goodwill": {
      "command": "npx",
      "args": ["tsx", "/path/to/goodwill-mcp/src/bin/stdio.ts"],
      "env": { "SPLITWISE_API_KEY": "your-key" }
    }
  }
}
```

Then: "Read my Splitwise groups and explain what Priya owes me in Lisbon."

## Run it locally (HTTP)

```bash
SPLITWISE_API_KEY=your-key npm run dev:http     # http://127.0.0.1:3000/mcp
```

## Host it (Cloudflare Worker, multi-user)

1. In your Splitwise app settings, set the callback URL to `https://<your-worker-host>/callback` and note the client id and secret.
2. `npx wrangler kv namespace create OAUTH_KV` and `npx wrangler kv namespace create GOODWILL_KV`; paste the ids into `wrangler.jsonc`.
3. Secrets: `npx wrangler secret put SPLITWISE_CLIENT_ID`, `SPLITWISE_CLIENT_SECRET`, `GOODWILL_STATE_KEY` (32+ random characters).
4. Set `ALLOWED_EMAILS` in `wrangler.jsonc` to the Splitwise account emails that may connect. Empty means nobody.
5. `npm run deploy`
6. In Claude, Settings > Connectors > Add custom connector: `https://<your-worker-host>/mcp`. Log in with Splitwise. Grant `read` and `add`.

Each person authorizes their own Splitwise account. The Splitwise token is stored encrypted, keyed by the access token the connector issues, and is only decrypted while serving that person's request. Details in [docs/SECURITY.md](docs/SECURITY.md).

## Develop

```bash
npm test                 # unit + in-process integration tests (vitest)
npm run typecheck        # Node entry points
npm run typecheck:worker # Cloudflare Worker
npm run evals            # 14 deterministic scenarios in evals/scenarios.yaml
npm run evals:model      # 7 of them through the Claude Code CLI with Haiku (costs tokens)
npm run conformance      # official MCP conformance suite vs conformance-baseline.yml
npm run smoke:worker     # boots wrangler dev and checks the OAuth plumbing
```

## Read in this order

1. [docs/plan.md](docs/plan.md): thesis, scope, schedule, cut order.
2. [docs/brief.md](docs/brief.md): the one-page product brief.
3. [docs/prd.md](docs/prd.md): requirements and the tool surface.
4. [docs/decisions/](docs/decisions/): why each big choice was made.
5. [docs/build-log.md](docs/build-log.md): every problem hit while building, the cause, and the fix.
6. [docs/research/](docs/research/): product audit, user voice, teardown of the unofficial servers, state of MCP.
7. [docs/metrics.md](docs/metrics.md), [docs/SECURITY.md](docs/SECURITY.md), and [docs/retrospective.md](docs/retrospective.md).

## Not affiliated with Splitwise

This project is not affiliated with, endorsed by, or supported by Splitwise, Inc. It uses the public Splitwise API under the Splitwise Developer Terms for personal, non-commercial use. It is not hosted for the public; the hosted mode is allowlisted.

## AI use

Claude Code helps build this project. The product decisions, the tool design, the safety model, and the writing in the brief and PRD are the author's own.
