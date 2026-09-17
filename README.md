# fairsplit-mcp

An unofficial MCP connector for Splitwise, built as a product and engineering showcase.

**Status:** planning. No code yet. The plan comes first, then the build.

## What this is

Splitwise is where friends, roommates, couples, and trip groups keep track of who owes whom. This project connects Splitwise to AI agents through the Model Context Protocol so a person can say "settle my Lisbon trip" and have it happen safely.

Thirty people have already built unofficial Splitwise MCP servers. None of them are usable by a normal person, and none treat writes as what they are in Splitwise: a change to other people's money. This project builds the slice that proves a better design and documents what an official connector should be.

## Two deliverables, one repo

1. **A product case.** Research, a one-page brief, a PRD, a decision log, and metrics from the prototype.
2. **An engineering case.** A server that follows the 2026-07-28 MCP specification, with OAuth, a write log, evals, conformance tests, observability, and a hosted deployment.

## Read in this order

1. [docs/plan.md](docs/plan.md): the full plan, scope, and four-week schedule.
2. [docs/brief.md](docs/brief.md): the one-page product brief.
3. [docs/prd.md](docs/prd.md): the product requirements.
4. [docs/decisions/](docs/decisions/): why each big choice was made.
5. [docs/research/](docs/research/): what we learned before deciding anything.
6. [docs/metrics.md](docs/metrics.md): what we measure and how.
7. [docs/SECURITY.md](docs/SECURITY.md): the threat model.

## Not affiliated with Splitwise

This project is not affiliated with, endorsed by, or supported by Splitwise, Inc. It uses the public Splitwise API under the Splitwise Developer Terms for personal, non-commercial use. It is not hosted for the public.

## AI use

Claude Code helps build this project. The product decisions, the tool design, the safety model, and the writing in the brief and PRD are the author's own.
