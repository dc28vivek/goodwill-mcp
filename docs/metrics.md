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

## Instrumentation

- Every tool call opens an OpenTelemetry span with the tool name, user hash, group hash, result type, and duration. Trace context follows the spec's `_meta` keys.
- Structured logs go to stderr locally and to the platform log sink when hosted. No secrets, no expense descriptions, no names in logs.
- A small dashboard shows the table above. Grafana Cloud free tier or the platform's analytics.

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
