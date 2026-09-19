# ADR-0008: Multi-user OAuth in v1, behind an allowlist

Status: accepted (2026-09-19)

## Context

A single-user server with an API key is enough for a demo. But the hardest engineering and the clearest product argument both live in token custody: Splitwise tokens have no scopes and never expire.

## Decision

v1 ships the hosted server as an OAuth 2.1 resource server with a token vault, Client ID Metadata Documents, and an email allowlist. The server defines its own scopes: `read`, `add`, `modify`.

## Alternatives

- Single-user only. Kept as the cut if week 3 slips (see the cut order in `plan.md`).

## Consequences

- Week 3 is auth work.
- `SECURITY.md` must document custody, revocation, and the allowlist.
