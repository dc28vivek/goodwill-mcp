# Retrospective

Draft after the v1 build, 2026-09-19. Rewrite in your voice before sharing. The build log has the details behind every line here.

## What we set out to do

Prove that a Splitwise connector for AI agents can be safe in a multi-player product, and write down what the official one should be. Six job-shaped tools, preview-and-confirm on every write, no delete, a duplicate guard, hosted with OAuth and our own scopes.

## What shipped

All of v1 as scoped in the plan, plus the hosted Worker that was scheduled for week 3. Six tools, three resources, one prompt. Stdio, local HTTP, and Cloudflare Worker entry points. 56 tests, 14 deterministic evals, 7 model-driven evals, the official conformance suite against a baseline, a Worker smoke test, CI. A build log with 20 entries.

## What worked

- **Deciding before building.** The ADRs were written first. Nothing in them changed during the build. The one that mattered most was ADR-0002: once every write had to preview and wait, the tool shapes followed.
- **Money as integers.** Zero rounding bugs. The three-way split test caught the remainder rule on day one and it never came back.
- **Reading the SDK types instead of the docs.** The docs lagged the 2026-07-28 release in a few places. The `.d.mts` files did not.
- **Two tsconfigs.** The Worker typecheck caught a `process` reference before it could fail in production.
- **A fake Splitwise API.** Tests, evals, conformance, and the model run all share one fake. Every scenario is repeatable and free.
- **Deterministic evals with product metrics in the output.** The same events the server emits in production are summarized after every eval run, so the metrics plan is a habit, not a document.

## What did not work, and what we did

- **The deterministic layers missed a whole-chain bug.** The HTTP fake doubled a path prefix. Unit, integration, evals, and conformance all passed because none of them crossed the CLI-to-stdio-to-HTTP-fake path. The first model-driven run found it in one call. Rule now: every layer gets one end-to-end test that crosses it.
- **The conformance suite is a year behind the spec.** No 2026-07-28 server scenarios exist yet, and most scenarios target the reference server's own tools. We kept it for the generic checks and wrote a baseline with the reason for every expected failure.
- **wrangler environments.** Bindings do not inherit into named environments. Cost an hour and a 500. Documented.
- **The explain sign for payments.** Written backwards, caught by a fixture with a real repayment. The fixture was worth more than the reasoning.

## What we would cut next time

- The per-scenario prompt strings in the deterministic evals. They are only used by the model run; the deterministic run never reads them.
- The `equal_group_split` path in the client types. We only ever post by shares.

## What is still open

- A deploy against a registered Splitwise app. Needs the client id and secret.
- User interviews. Five to eight organizers. The guide is written.
- Real numbers in `metrics.md`. Two weeks of use by at least three people.
- Percentage and share-based splits. Receipt images. The MCP App for itemization.
- OpenTelemetry spans and a dashboard once the hosted server has users.

## The one thing to remember

The protocol was the easy part. Every hard decision was about trust: who confirms, what counts as an instruction, what can never be undone, and where a token may live. That is the product.
