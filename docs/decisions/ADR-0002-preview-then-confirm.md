# ADR-0002: Every write previews and waits for confirmation

Status: proposed

## Context

An expense posted by an agent changes the balances of everyone in the group. A wrong write is a social event, not a data event. The 2026-07-28 spec supports this through multi round-trip requests.

## Decision

Every write tool first returns `resultType: "input_required"` with a plain-language preview that names the people whose balances change. The write happens only on a retry that carries the confirmation and the same `requestState`.

## Alternatives

- Write immediately and offer undo. Rejected: other members see the wrong number before the undo.
- Rely on the client's own confirmation prompt. Rejected: client behavior varies, and headless clients have none.

## Consequences

- Every write costs one extra round trip.
- Preview accept rate becomes a primary metric.
