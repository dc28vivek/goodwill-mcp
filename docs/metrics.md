# Metrics

## What we measure and why

| Metric | Why it matters | How it is captured |
|---|---|---|
| Connect-to-first-call rate | Does onboarding work | Count of authorized users vs users with one successful tool call |
| Preview accept rate | Are the proposals right | Confirmed writes / previews shown, per tool |
| Duplicates blocked per 100 writes | Is the guard doing work | Write log refusals / attempted writes |
| Seconds from instruction to posted expense | Is this faster than the form | Timestamp on first tool call vs write success, per session |
| Settle-ups started from agent sessions | Does explaining lead to paying | `settle_plan` calls followed by a recorded payment within 7 days |
| Tokens per tool call | Are outputs trimmed | Estimated from response size, logged per call |
| p50 and p95 latency per tool | Is it usable | OTel spans |
| Errors per 100 calls, by type | What breaks | `isError` results and exceptions |

## Guardrails

- Writes reverted by users within 24 hours (they edited or deleted in the app).
- Complaints or comments from other group members about agent-created expenses.

## Instrumentation (as built, 2026-09-19)

`src/server/metrics.ts` emits one JSON event per line. Locally that is stderr; on Cloudflare it is the console, which Workers Observability captures and lets you query. No names, descriptions, or amounts appear in any event.

Events:

| Event | When |
|---|---|
| `tool_call {tool, ok, ms, round}` | Every tool handler run. `round` is 1 for the first call and 2 for the confirmed retry. |
| `preview_shown {tool}` | A write tool returned a preview and asked for confirmation. |
| `preview_confirmed {tool}` / `preview_declined {tool}` | The person's answer. |
| `duplicate_blocked {tool, source}` | `write_log`: refused a repeat of our own recent post. `splitwise`: a likely duplicate already in Splitwise was surfaced in the preview. |
| `write_posted {tool}` | An expense or comment reached Splitwise. |

From these: preview accept rate = confirmed / shown; duplicates blocked per 100 writes; p50 and p95 latency per tool from `ms`; error rate from `ok`. `npm run evals` prints this summary for the eval run, using the same events.

Still to do: OpenTelemetry spans with the spec's `_meta` trace propagation, and a dashboard once the hosted server has real users.

## Prototype numbers

Fill in after two weeks of real use with the test group and at least three real users.

| Metric | Value | Date |
|---|---|---|
| Sessions | | |
| Writes proposed | | |
| Writes confirmed | | |
| Duplicates blocked | | |
| Median seconds to post | | |
| p50 latency | | |

## What surprised us

Write this last.
