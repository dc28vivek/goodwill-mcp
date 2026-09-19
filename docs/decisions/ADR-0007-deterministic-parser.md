# ADR-0007: Deterministic parser first, model second

Status: accepted (2026-09-19)

## Context

`add_expense` turns "dinner 84, I paid, split with everyone in Lisbon" into a proposed expense. A model can do this, but the result is hard to test and can drift.

## Decision

A deterministic parser handles amount, payer, group, participants, and date for the common shapes. The model is asked only for the ambiguous tail, and its output is validated against the same schema.

## Alternatives

- Model-only parsing. Rejected: untestable, and a wrong parse becomes a wrong preview for five people.

## Consequences

- A parser test suite with real sentences from interviews.
- Coverage of the parser is a metric: share of sentences parsed without the model.
