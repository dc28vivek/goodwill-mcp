# Release notes

## 0.1.0 (2026-09-19)

First working release of fairsplit-mcp, an unofficial Splitwise connector for AI agents.

### What you can do

- **Ask why you owe what you owe.** `explain_balance` shows the net number with a person or a group and the expenses behind it, including payments.
- **Find who is late.** `stale_balances` lists balances open longer than a number of days, oldest first.
- **Close out a group.** `settle_plan` gives the minimum set of payments and says whether it matches what Splitwise shows.
- **Catch double posts.** `reconcile` flags expenses that look like duplicates, with a confidence and a suggested action. It never deletes.
- **Add an expense in one sentence.** `add_expense` understands "dinner 84, I paid, split with everyone," shows a preview naming everyone whose balance changes, and posts only after you confirm.
- **Send a reminder without the awkwardness.** `nudge` drafts a comment in a gentle, plain, or firm tone and posts it after you confirm.

### How it keeps you safe

- Every write shows a preview and waits for a yes.
- A write log refuses to post the same expense twice within 48 hours, even across retries and devices.
- Text written by other group members is treated as data, never as instructions.
- Nothing is ever deleted.
- Hosted mode uses OAuth with `read`, `add`, and `modify` scopes and an email allowlist. Your Splitwise token is stored encrypted and decrypted only while serving your own request.

### Ways to run it

- Locally over stdio with a personal Splitwise API key (Claude Code, Claude Desktop, Cursor).
- Locally over Streamable HTTP for development.
- Hosted on Cloudflare Workers for a small allowlisted group, as a Claude custom connector.

### Under the hood

- Implements the MCP specification revision 2026-07-28: stateless requests, `server/discover`, multi round-trip confirmations, structured tool output with schemas, cache hints on lists.
- 55 unit and integration tests, 14 deterministic evals, the official MCP conformance suite against a documented baseline, and a Worker smoke test.

### Known limits

- Equal splits only. Percentage and share-based splits come next.
- No receipt images yet.
- Payment links are not generated; the settle plan tells you who pays whom and you pay in your usual app.
- The protected-resource metadata document does not list scopes; clients read them from the authorization-server metadata.
- Not deployed against a registered Splitwise app yet.

### Not affiliated with Splitwise

This is a personal, non-commercial project under the Splitwise Developer Terms. It is not endorsed by Splitwise, Inc.
