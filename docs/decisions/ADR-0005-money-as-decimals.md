# ADR-0005: Money as decimal strings, never floats

Status: accepted (2026-09-19)

## Context

Splitwise requires that shares sum exactly to the cost. Floats drift. A one-cent mismatch rejects the write or, worse, posts a wrong split.

## Decision

Money is carried as decimal strings at the API boundary and integer minor units inside the domain code. Splits are computed in minor units. The remainder from rounding goes to the payer.

## Alternatives

- Floats with rounding at the end. Rejected: unit tests show off-by-one-cent errors on three-way splits.

## Consequences

- A small money module with its own tests.
- Multi-currency needs the minor-unit exponent per currency.
