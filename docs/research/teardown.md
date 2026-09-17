# Teardown: unofficial Splitwise MCP servers

Checked 2026-09-16.

## Count

- About 30 Splitwise MCP servers on GitHub, out of 55 search hits. Almost all created between mid-2025 and now.
- Languages: mostly Python, then TypeScript, one Ruby (35 tools), one Rust.
- Packages: `splitwise-mcp` and `@mrpirated/splitwise-mcp` on npm; `splitwise-mcp` and `splitwise-mcp-server` on PyPI.
- Directories: about 8 on Glama, one hosted on Smithery.
- No official server. dev.splitwise.com lists community SDKs and no MCP.

## Traction

- Top repo: tarunn2799/splitwise-mcp, 12 stars, 15 forks.
- Everything else: 0 to 4 stars. Most are one-person weekend builds with one commit.
- Actively maintained this month: chrischall, fernandosmither, svarun115.

## Notable implementations

| Repo | What it does well | Stack |
|---|---|---|
| tarunn2799/splitwise-mcp | Fuzzy name and group resolution. OAuth and API key. | Python |
| sarathfrancis90/splitwise-mcp | Confirm gates through elicitation. Reserve-then-finalize SQLite write log. Idempotency keys. Read-only registration pattern for low-trust channels. | Python |
| fernandosmither/splitwise-mcp | Hosted OAuth proxy, Streamable HTTP, email allowlist, works as a Claude custom connector. Confirm on every write. States the token-custody problem plainly. `parse_sentence` proposes without saving. | Python, FastMCP |
| vishnujayvel/splitwise-mcp | Atomic duplicate prevention. | Python |
| HiFinance-pvt/splitwise-mcp | Cloudflare Workers with Durable Objects and OAuth. Uses the deprecated SSE transport. | TypeScript |
| chrischall/splitwise-mcp | npm `splitwise-mcp`. Openly AI-built. Good summary of the Splitwise terms. Downloads receipts. | TypeScript |

## What they lack

1. **A canonical, trusted one.** Thirty near-identical wrappers and four package names. A normal person cannot pick.
2. **Safe hosting.** Almost all are stdio plus an API key in an env var. Terminal-only, single-user. Three do remote OAuth. Only one says out loud that Splitwise tokens have no scopes and never expire.
3. **Write safety.** Most expose delete with no confirmation. Three treat writes as dangerous. The best dedupe is local to one machine.
4. **Job-shaped tools.** All are 1:1 API mirrors, 26 to 35 tools, raw payloads. None answer "settle my trip," "who is late," "why do I owe this."
5. **Computed read models.** No balance age, no explanation of simplified debts, no category rollups.
6. **Receipts in, events out.** One downloads receipts. None turn a photo into an itemized split. None poll notifications.
7. **A business.** Splitwise's Developer Terms: not for commercial use, no fee-based service, no app that replicates or competes with Splitwise. Rate limits are undocumented but "fairly lenient."

## The conclusion

Demand is proven. Supply is fragmented. The terms make it impossible for anyone but Splitwise to ship the trusted, hosted, multi-user version. That is the argument for an official connector as a Pro feature.

For this project: do not build wrapper number 31. Build the one that is job-shaped, confirm-gated, and hosted correctly, and write down what the official one should be.

## Sources

- https://github.com/tarunn2799/splitwise-mcp
- https://github.com/sarathfrancis90/splitwise-mcp
- https://github.com/fernandosmither/splitwise-mcp
- https://github.com/vishnujayvel/splitwise-mcp
- https://github.com/HiFinance-pvt/splitwise-mcp
- https://github.com/chrischall/splitwise-mcp
- https://smithery.ai/servers/splitwise
- https://dev.splitwise.com/
