# ADR-0001: Six job-shaped tools, not an API mirror

Status: proposed

## Context

Thirty unofficial servers expose 26 to 35 tools that map one-to-one to Splitwise API endpoints. The model has to compose them, and raw payloads fill the context window. Users do not think in endpoints. They think "why do I owe this," "who is late," "settle the trip."

## Decision

Ship six tools named after jobs: `explain_balance`, `stale_balances`, `add_expense`, `reconcile`, `settle_plan`, `nudge`. Each returns only the fields the model needs, with an `outputSchema`.

## Alternatives

- Mirror the API. Rejected: proven not to help, see `research/teardown.md`.
- Two tools, "read" and "write," with a free-form action string. Rejected: loses schema validation and annotations.

## Consequences

- Some API capabilities are unreachable through the connector. That is fine. The app exists.
- Tool descriptions become product copy and get rewritten from interview language.
