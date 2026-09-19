# Internal initiative brief: Splitwise connector for AI agents

Draft for review. Written as if for Splitwise's product team. Edit in your voice before sharing.

**Owner:** Product Manager, Growth and Fintech
**Status:** proposal, prototype exists
**Ask:** one engineer and one designer for one quarter, plus compliance review time

## The one-line

Ship an official Splitwise connector for AI agents, as a Pro feature, so a person can say "settle my Lisbon trip" in Claude or ChatGPT and have it happen with the same safety they expect from the app.

## Why now

1. **Demand is proven.** About 30 unofficial Splitwise MCP servers were built between mid-2025 and September 2026. Nobody paid anyone to do that.
2. **None of them are usable by a normal person.** All are API mirrors with 26 to 35 tools, most need a terminal and an API key, and most expose delete with no confirmation.
3. **Only we can ship the real one.** The Developer Terms forbid commercial third-party use and fee-based services. The unofficial servers cannot become products. The trusted, hosted, multi-user connector has to come from us.
4. **The protocol matured in July 2026.** A remote MCP server is now an ordinary stateless HTTP service behind OAuth. The plumbing is easy. The trust model is the product, and the trust model is ours to define.
5. **Distribution exists.** Claude and ChatGPT both have connector directories. A listing there is a new acquisition channel for Pro.

## Who this is for

The organizer: the one person per group who creates it, enters most expenses, fronts money, explains the math, and chases. Every top complaint in our feedback board and on Reddit is an organizer complaint: the entry form, "why do I owe this," chasing, and the daily cap hitting mid-trip. The connector takes the three chores off the organizer and leaves them the decisions.

## What we would ship

Six tools, not thirty. `explain_balance`, `stale_balances`, `settle_plan`, `reconcile`, `add_expense`, `nudge`. Three read-only resources for groups, categories, and currencies. One prompt, "close out a trip."

The rules that make it safe in a multi-player product:

- Every write previews who is affected and waits for the person to confirm.
- Text written by other members is data, never instructions.
- No delete.
- A write log refuses duplicate posts across retries and devices.
- Scoped access (`read`, `add`, `modify`) even though our API tokens have no scopes today.

## Business case

- **Pro conversion.** The connector is Pro-only. It is the first Pro feature that is a capability rather than a lifted limit, which is a better story than the daily cap.
- **Retention.** More expenses logged with less effort, balances explained without the organizer, reminders sent without the social cost. Each of these is a reason not to move the next group to Tricount.
- **Settle-up volume.** `settle_plan` ends in a payment. In the US that is Splitwise Pay.

## What we measure

Preview accept rate on writes, duplicates blocked per hundred writes, median seconds from instruction to posted expense, settle-ups started from agent sessions, Pro conversion from the connector listing, and 90-day retention of connected users versus matched controls.

## Risks

- **Token custody.** Our tokens have no scopes and do not expire. The connector must hold them encrypted and must add its own scopes. This is also the argument for scoped tokens in the API itself.
- **Prompt injection through comments.** A member can type instructions into a description. The design treats fetched text as data and gates every write behind a preview. Needs a red-team pass.
- **Wrong writes at social scale.** A bad post is visible to five people. Preview-and-confirm plus no-delete keeps the worst case at "one extra visible expense."
- **Support load.** New failure modes ("the agent said it posted but it did not"). Instrument from day one.

## What exists today

A working prototype: the six tools, stdio and hosted modes, OAuth with our own scope tiers, 55 tests, 14 deterministic evals, conformance against the official suite, and a build log of every problem hit. It is unofficial and allowlisted. It is the spec for the official one, in runnable form.

## Decision needed

Approve a one-quarter build of the official connector on the prototype's design, with compliance review of token custody and the connector directory listings as the launch gate.
