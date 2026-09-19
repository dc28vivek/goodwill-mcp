# Plan

Last updated: 2026-09-19

## Status

Weeks 1 to 3 of the schedule below are built as of 2026-09-19: domain logic with tests, the six tools, stdio and local HTTP entry points, the Cloudflare Worker with OAuth and scope tiers, deterministic evals, model-driven evals through the Claude Code CLI, the conformance harness with a baseline, a Worker smoke test, product metrics events, and CI. Not done: a deploy against a real Splitwise app (needs the client id and secret), user interviews, the metrics dashboard with real numbers, and the week-4 items (App, demo video, retrospective). The build log records every problem hit so far.

## Goal

Build an unofficial Splitwise MCP connector that shows two things at once: product judgment and engineering craft. The code is evidence. The product thinking is the exhibit.

## Thesis

1. Splitwise's real customer is the organizer: the one person per group who creates it, enters most expenses, fronts money, explains the math, and chases.
2. The most-hated moments are entry, explaining a balance, and chasing. The research in `docs/research/` shows this.
3. Every write in Splitwise changes other people's money. The trust model is the product.
4. Thirty unofficial MCP servers exist. None are usable by a normal person. Splitwise's API terms stop anyone but Splitwise from shipping a commercial one. So the right outcome is an official connector, and this prototype shows what it should be.

## Constraints

- **Splitwise Developer Terms.** Personal, non-commercial. Respect rate limits. No fee-based service. Do not present the project as official.
- **Hosting.** Single-user, or multi-user behind an email allowlist. Never open to the public.
- **Demo data.** A test Splitwise account with a fake trip group. No real names on video.
- **AI use.** Claude Code builds. The author owns the decisions and writes the brief, the PRD narrative, and the application email.

## Scope

### v1 (this plan)

Six tools, three resources, one prompt. Read-only by default. Every write previews who it affects and waits for confirmation.

| Tool | Job | Kind |
|---|---|---|
| `explain_balance` | Show the net balance with a group or friend and the expenses behind it | read |
| `stale_balances` | List balances that are older than N days, with age and amount | read |
| `add_expense` | Turn a sentence or a receipt into a proposed split, confirm, then write | write |
| `find_duplicates` | Find likely duplicate expenses in a group and propose merges | read, then write on confirm |
| `settle_plan` | Produce the minimum set of payments to close a group, with a pay link per person | read |
| `nudge` | Draft a reminder in a chosen tone and post it as a comment on confirm | write |

Resources: `splitwise://groups`, `splitwise://categories`, `splitwise://currencies`, each with a long `ttlMs`.

Prompt: `close_out_trip`.

Not in v1: delete of any kind, group membership changes, receipt itemization UI, payments that move money.

### v2

Multi-user OAuth with a token vault and an email allowlist. `subscriptions/listen` for change notifications. Tasks extension for long reconciliations.

### v3

MCP App for receipt itemization (tap who had what). Webhook-driven events when the protocol adds them.

## Engineering bases

### Protocol: 2026-07-28

- Stateless. No `initialize` handshake. Every request carries protocol version and client info in `_meta`.
- Implement `server/discover`.
- Streamable HTTP for the hosted server. stdio for local development. No HTTP+SSE.
- Confirmations use the multi round-trip pattern: the tool returns `resultType: "input_required"`, the client retries with `inputResponses`.
- Every tool has an `outputSchema` and returns `structuredContent`.
- `ttlMs` and `cacheScope` on every list result. Tools are returned in a fixed order.
- Annotations are set honestly: `readOnlyHint`, `destructiveHint`, `idempotentHint`.
- Errors that the model can fix are returned as tool results with `isError: true` and a plain instruction.
- Do not use sampling, roots, logging, dynamic client registration, or SSE. All are deprecated.

### Auth and token custody

- The server is an OAuth 2.1 resource server: protected-resource metadata (RFC 9728), PKCE, resource indicators (RFC 8707), `iss` validation (RFC 9207).
- Client registration through Client ID Metadata Documents.
- Splitwise tokens have no scopes and do not expire. Store them encrypted. Never send them to the model or the client. The client gets a short-lived reference token.
- The server defines its own scopes: `read`, `add`, `modify`. There is no `delete` scope in v1.
- Email allowlist on the hosted instance.

### Splitwise client

- Typed client with retries and backoff on 429. Per-user rate limiting. Cached reference data. Pagination.
- Money is handled as decimal strings or integer minor units. Never floats. Splits must sum exactly to the cost, with a deterministic rule for the remainder.
- Dates are UTC in the API and local for the user. Convert once, at the edge.

### Domain logic

- Balance explainer: per-pair contributions behind a net number.
- Stale balances: age, amount, last activity.
- Duplicate detection: fingerprint on amount, date window, payer, and normalized description.
- Settle plan: minimum cash flow, checked against Splitwise's own simplified debts.
- Sentence parser: deterministic first. A model helps only with the ambiguous tail. This keeps it testable.

### Safety

- All fetched text (descriptions, comments, names) is wrapped as data. Other group members write that text. It can carry prompt injection.
- Every write returns a preview that names the people whose balances change. The write happens only after confirmation.
- A per-user write log with idempotency keys blocks duplicate posts across retries and devices.
- The upstream host is fixed in code. No tool argument can change it.
- Inputs are validated against schemas. Secrets never reach logs.
- The threat model lives in `docs/SECURITY.md`.

### Testing

- Unit tests: split rounding, simplification, duplicate detection, parser.
- Contract tests: recorded Splitwise API fixtures. One live smoke test against the test account, behind a flag.
- The official MCP conformance suite runs in CI.
- Evals: 15 to 20 scenarios with expected tool sequences, scored by a runner. These are the acceptance tests.

### Operations

- CI: lint, typecheck, unit, contract, conformance, build. Deploy on tag. Dependabot and secret scanning.
- Observability: OpenTelemetry traces with the spec's `_meta` propagation, structured logs, a small dashboard, error tracking.
- Deploy: Cloudflare Workers with KV for the write log and the token vault. `wrangler.toml` is the infrastructure definition. Dev and prod environments. Health endpoint. One-page runbook.
- Distribution: `server.json` for the MCP registry. Install snippets for Claude Desktop, Claude Code, Cursor, and ChatGPT. MIT license. Unofficial disclaimer and a summary of the Splitwise terms.

## Product bases

- **Research.** Product audit, teardown of the unofficial servers, Reddit and feedback-board synthesis. All in `docs/research/`. Still to do: five to eight interviews with organizers. Guide in `docs/research/interview-guide.md`.
- **Brief.** One page, in the author's words. `docs/brief.md`.
- **PRD.** Problem, goals, non-goals, personas, stories, tool surface, flows, edge cases, metrics, roadmap, open questions. `docs/prd.md`.
- **Decision log.** One ADR per big choice, each linked to evidence. `docs/decisions/`.
- **Metrics.** Instrumentation plan and real numbers from the prototype. `docs/metrics.md`.
- **Ethics and compliance.** Terms, privacy, retention, token custody, and the line we do not cross: no reliability score shown to other users.
- **Retrospective and recommendation.** A one-page memo at the end: what worked, what was cut, what Splitwise should build.

## Four-week schedule

| Week | Engineering | Product |
|---|---|---|
| 1 | Stateless server over stdio. Typed client with fixtures. Domain logic with unit tests. Three read tools. | Brief v1. PRD v1. Interview five users. ADRs 1 to 3. |
| 2 | Write tools with preview and confirm. Write log. Evals runner. Conformance in CI. | Metrics plan. Instrumentation. ADRs 4 to 6. Tool copy rewritten in users' language. |
| 3 | Hosted deploy with OAuth, token vault, allowlist. OTel and dashboard. Registry manifest. | Dashboard filled with real numbers. Security section. Roadmap. |
| 4 | MCP App for receipts, or cut. Polish. Demo video. | Retrospective. Recommendation memo. Final brief. Rehearse the two-minute story. |

## Cut order

If time runs out, cut in this order:

1. The MCP App.
2. Multi-user OAuth (keep a single-user hosted server).
3. The OTel dashboard (keep metrics in logs).

Never cut the evals, the write log, or the brief.

## Decisions made

- TypeScript with the v2 MCP packages. They implement 2026-07-28 and run on Cloudflare Workers.
- Cloudflare Workers plus KV.
- Multi-user OAuth in v1, behind an allowlist. It is the strongest engineering signal, and the token-custody write-up is the strongest product signal.
- The App is a week-4 stretch.

See `docs/decisions/` for the reasoning.

## Definition of done

- A person can add the connector to Claude, log in with their own Splitwise account, and complete "settle my Lisbon trip" end to end.
- Every write shows a preview and waits.
- Evals pass. Conformance passes. CI is green.
- The brief, PRD, ADRs, metrics, and security docs are complete.
- A two-minute demo video exists.
