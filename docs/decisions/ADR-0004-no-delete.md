# ADR-0004: No delete in v1

Status: accepted (2026-09-19)

## Context

Deleting an expense or a group removes shared history for everyone. The unofficial servers expose delete freely. The most useful jobs do not need it.

## Decision

v1 has no delete tool and no `delete` scope. `reconcile` proposes merges by updating one expense and commenting on the other. If a deletion is truly needed, the user does it in the app.

## Alternatives

- Confirm-gated delete. Deferred to v2 if evals show a real need.

## Consequences

- Some cleanups take one extra step in the app.
- The worst case for a bad agent run is an extra visible expense, never lost history.
