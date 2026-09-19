# ADR-0009: Tool names state the job in the user's words

Status: accepted (2026-09-19)

## Context

Claude Code, and likely other hosts as MCP tool catalogs grow, load MCP tools lazily: the model searches for a tool by keyword, then loads its schema. The 2026 MCP roadmap calls this "progressive discovery" and plans to standardize it. In a model-driven eval the tool named `reconcile` was never found for the question "any duplicates in Lisbon?", while `explain_balance`, `stale_balances`, and `settle_plan` were found every time.

## Decision

A tool's name is the job in the words a person would say: `find_duplicates`, not `reconcile`. Names use verbs a user would type, plus the noun they would type. Descriptions still carry the detail, but the name has to survive a keyword search on its own.

## Alternatives

- Keep short internal names and rely on descriptions. Rejected: it failed in practice against a real client.
- Add aliases. Rejected: MCP has no alias concept, and duplicate tools confuse the model.

## Consequences

- `reconcile` was renamed to `find_duplicates`. Docs and collateral updated.
- New tools get a naming check in review: would a keyword search for the user's sentence hit this name?
