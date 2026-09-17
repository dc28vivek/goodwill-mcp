# The state of MCP, September 2026

MCP is 22 months old and has shipped five specification revisions.

## Timeline

| Revision | What changed |
|---|---|
| 2024-11-05 | Launch. Tools, resources, prompts. stdio and HTTP+SSE. Sampling, roots. |
| 2025-03-26 | OAuth 2.1 authorization. Streamable HTTP replaces SSE. Tool annotations. Audio content. |
| 2025-06-18 | Structured tool output with `outputSchema`. Elicitation. Resource links. Servers as OAuth resource servers (RFC 9728, RFC 8707). |
| 2025-11-25 | Experimental tasks. URL-mode elicitation. Client ID Metadata Documents. Icons. Tool naming rules. Sampling with tools. Formal governance, working groups, SDK tiers. |
| 2026-07-28 | Stateless: no `initialize`, no sessions, `_meta` carries version and client info on every request. `server/discover`. Multi round-trip requests replace server-initiated elicitation and sampling. `subscriptions/listen` for push. Tasks moved to an extension. Deprecated: sampling, roots, logging, dynamic client registration, HTTP+SSE. Extensions formalized: Tasks, MCP Apps, Skills over MCP. |

## Adoption

- One-year mark (December 2025): 97M monthly SDK downloads, about 10,000 active servers.
- July 2026: close to half a billion downloads a month. TypeScript and Python SDKs past 1 billion total.
- Governance moved to the Agentic AI Foundation under the Linux Foundation in December 2025. Anthropic, OpenAI, and Block are founding members.

## Roadmap (updated 2026-08-22)

1. Agentic messaging: server-initiated events including webhooks; composing Tasks, subscriptions, and progress.
2. HTTP-native transport: Streamable HTTP over stdio as the single binding; ETags for caching.
3. Agent identity: DPoP; delegated identity for agents acting without a human present; token exchange.
4. Primitives: redesign the tool result shape; progressive discovery instead of full catalogs; content annotations.
5. SDK experience: generated SDKs validated against a conformance suite.

## What this means for a server built now

- Build to 2026-07-28. A remote server is an ordinary stateless HTTP service speaking JSON-RPC behind OAuth.
- Confirmations use `resultType: "input_required"` and a retry with `inputResponses`. Do not use the old elicitation push.
- Do not use sampling, roots, logging, dynamic client registration, or SSE.
- Put `outputSchema` on every tool. Put `ttlMs` and `cacheScope` on every list. Return tools in a fixed order.
- State lives in handles passed as tool arguments, not in sessions.
- Register clients through Client ID Metadata Documents.
- Run the official conformance suite in CI.
- The plumbing is easy now. Tool design, the trust model, and distribution are the work.

## Sources

- https://modelcontextprotocol.io/specification/latest/changelog
- https://modelcontextprotocol.io/specification/2025-11-25/changelog
- https://modelcontextprotocol.io/development/roadmap
- https://modelcontextprotocol.io/extensions/apps/overview
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- https://blog.modelcontextprotocol.io/posts/2025-12-09-mcp-joins-agentic-ai-foundation/
