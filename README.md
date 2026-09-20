# Goodwill

**An unofficial Splitwise MCP server.** Ask why you owe what you owe, settle up a trip, add an expense in a sentence, and remind someone without the awkwardness. Every write shows who it affects and waits for your yes. Nothing is ever deleted.

> In accounting, goodwill is the value of a relationship that never appears on the balance sheet. That is what a shared-expense app is actually protecting. The ledger is in service of the goodwill, not the other way round.

Not affiliated with Splitwise, Inc.

## Try it (60 seconds)

You need a Splitwise API key. Register an app at [secure.splitwise.com/apps](https://secure.splitwise.com/apps), give it any name, and copy the key.

**Claude Code**

```bash
claude mcp add goodwill -e SPLITWISE_API_KEY=your-key -- npx -y goodwill-mcp
```

**Claude Desktop, Cursor, or any MCP client**

```json
{
  "mcpServers": {
    "goodwill": {
      "command": "npx",
      "args": ["-y", "goodwill-mcp"],
      "env": { "SPLITWISE_API_KEY": "your-key" }
    }
  }
}
```

Your key stays on your machine. Nothing is sent anywhere except Splitwise's own API.

## What you can ask it

- *"What happened in my groups this week?"* — the activity feed, grouped by group
- *"Was rent split this month?"* — it lists the expenses, you judge what counts as rent
- *"How much do I owe overall, and how much is owed to me?"*
- *"Why do I owe Priya 61?"* — every expense with its total and your share of it
- *"What has Sam run up since he last paid me?"* — or since you last settled, or since a date
- *"Here's my card statement — which of these aren't in Splitwise yet?"*
- *"Any duplicate expenses in the Lisbon group?"*
- *"Who's more than 30 days late paying me back?"*
- *"How do we settle Lisbon?"* — the fewest payments that close the group
- *"Add dinner 84, I paid, split with everyone"* — shows the split and who it affects, then waits
- *"Here's a photo of the bill — I had the steak, Priya had the salad"* — splits by item, tax and tip in proportion
- *"Create a Goa Trip group with Priya and Sam"* — then add expenses to it
- *"That dinner was actually 90, not 84"* — shows before and after, and what each share becomes
- *"Priya paid me back, record it"* — closes the balance

Fifteen tools, three resources, one prompt:

| Tool | What it does | Writes? |
|---|---|---|
| `explain_balance` | Charged, paid back, what's left, and every expense with your share of it | no |
| `recent_activity` | What changed: expenses added, comments, people joining, settle-ups | no |
| `list_expenses` | What was spent in a group or with a person, over a date range | no |
| `read_expense` | One expense in full: every share, the notes, the comment thread | no |
| `overall_balances` | Everything you owe and are owed, across every group | no |
| `find_missing_expenses` | Which card transactions haven't been added to Splitwise yet | no |
| `stale_balances` | Who is late, by how long | no |
| `settle_plan` | Minimum payments to close a group, checked against Splitwise | no |
| `find_duplicates` | Likely duplicates with a confidence and a suggested action | no |
| `create_group` | A new group, with friends added and strangers invited by email | after confirmation |
| `add_to_group` | People added to an existing group | after confirmation |
| `add_expense` | A sentence or fields, a preview, then a confirmed post | after confirmation |
| `update_expense` | Corrects an amount, description, date or category, rescaling shares | after confirmation |
| `split_by_items` | A receipt split line by line, tax and tip allocated proportionally | after confirmation |
| `settle_up` | Records a payment that already happened, closing the balance | after confirmation |

`find_missing_expenses` and `find_duplicates` are two halves of the same job: making the ledger match reality. One finds what's missing from Splitwise, the other finds what's in there twice.

For `split_by_items`, your client reads the receipt and this tool does the arithmetic. That split is deliberate: reading a photo is fuzzy work a model is good at, while allocating tax proportionally and making shares sum exactly to the total is exact work that belongs in code. Pass the printed total and it refuses to post when the lines don't add up, so a misread digit doesn't become five wrong balances.

Resources: `splitwise://groups`, `splitwise://categories`, `splitwise://currencies`. Prompt: `close_out_trip`.

## How it keeps you safe

Every expense you add changes what other people owe. So:

- **Every write previews and waits.** The tool returns the split, names the people whose balances change, and posts only after you confirm. This uses the MCP 2026-07-28 multi round-trip pattern, so the confirmation is a real protocol step, not a prompt the model can talk itself out of.
- **Every change signs itself.** An expense this connector adds or corrects gets a comment saying what happened and that Goodwill MCP did it, visible to everyone on the expense. Splitwise attributes expenses to the app that made them, but that is easy to miss; a comment is not.
- **No deletes.** There is no tool that removes an expense, a group, or a member. If a duplicate should go, you remove it in the Splitwise app.
- **Corrections show what they overwrite.** `update_expense` is the only tool that changes something people have already seen, so its preview puts the current values next to the new ones and spells out what each person's share becomes. On the hosted server it needs a `modify` scope that is not granted by default.
- **No double posts.** A write log keyed by group, amount, day, payer and normalised description refuses to post the same expense twice within 48 hours, across retries and across devices. The fingerprint is reserved before the upstream call, not merely looked up, so two requests racing each other cannot both win.
- **Text from your group is data, not instructions.** Descriptions and comments are written by other members and could contain anything. The server labels them as data and no tool can redirect where a request goes.

## Other ways to run it

**Local HTTP** for development:

```bash
SPLITWISE_API_KEY=your-key npm run dev:http     # http://127.0.0.1:3000/mcp
```

**Hosted, multi-user** as a Cloudflare Worker with a full OAuth 2.1 authorization server, so each person signs in with their own Splitwise account instead of pasting a key:

1. In your Splitwise app settings, set the callback URL to `https://<your-worker-host>/callback`.
2. `npx wrangler kv namespace create OAUTH_KV`; paste the id into `wrangler.jsonc`.
3. Secrets: `npx wrangler secret put SPLITWISE_CLIENT_ID`, `SPLITWISE_CLIENT_SECRET`, `GOODWILL_STATE_KEY` (32+ random characters).
4. Set `ALLOWED_EMAILS` in `wrangler.jsonc`. Empty means nobody.
5. `npm run deploy`, then add `https://<your-worker-host>/mcp` as a custom connector. Operating notes are in [RUNBOOK.md](RUNBOOK.md).

A Splitwise access token never expires and has no scopes, so a hosted deployment holds permanent full account access for every user. Goodwill stores each token encrypted, decrypts it only while serving that person's own request, and adds `read`, `add` and `modify` scopes of its own because Splitwise has none. It is allowlisted by design. See [SECURITY.md](SECURITY.md).

## Design notes

Six tools shaped like jobs rather than a mirror of the Splitwise API, because a model picks
tools by name and description and cannot usefully compose thirty endpoints. Money is handled
as integer minor units and only ever crosses the wire as a decimal string, because Splitwise
requires shares to sum exactly to the cost. Sentences are parsed deterministically first and
only handed to a model for the ambiguous tail, so the behaviour is testable.

## Develop

```bash
npm run lint             # oxlint
npm test                 # unit + in-process integration tests (vitest)
npm run typecheck        # Node entry points
npm run typecheck:worker # Cloudflare Worker
npm run evals            # deterministic scenarios in evals/scenarios.yaml
npm run evals:model      # a subset through the Claude Code CLI (costs tokens)
npm run conformance      # official MCP conformance suite vs conformance-baseline.yml
npm run smoke:package    # packs, installs the tarball elsewhere, drives the installed binary
npm run smoke:worker     # boots wrangler dev and checks the OAuth plumbing
npm run build            # compile the publishable stdio server to dist/
npm run doctor           # read-only check against YOUR real Splitwise account (needs SPLITWISE_API_KEY)
npm run sweep            # exercises every write tool in a throwaway group on your real account
```

## Not affiliated with Splitwise

This project is not affiliated with, endorsed by, or supported by Splitwise, Inc. It uses the public Splitwise API under the [Splitwise Developer Terms](https://dev.splitwise.com/) for personal, non-commercial use.

## AI use

Built with Claude Code. The product decisions, the tool design and the safety model are the author's own.

## License

MIT
