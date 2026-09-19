# PRD: goodwill-mcp v1

Status: v1 built (2026-09-19). The tool surface and flows below match the code in `src/tools/`. The narrative sections are marked for rewriting in the author's voice. Differences from the original v0 draft: `find_duplicates` is read-only in v1 (no confirm-gated merge); `settle_plan` does not generate payment links yet; `nudge` posts a comment (Splitwise has no reminder endpoint).

## Problem

[Rewrite in your voice.] Splitwise keeps a fair ledger, but the work of keeping it falls on one person per group. That person types every expense into a form, explains balances by hand, and chases friends who are late. An AI agent can do the typing, the explaining, and the chasing. It can also post a wrong expense to five people at once. The product problem is to give the organizer the help without giving up the safety.

## Goals

1. An organizer can log an expense from one sentence or one photo in under ten seconds.
2. Anyone in a group can ask "why do I owe this" and get the expenses behind the number.
3. An organizer can close out a trip with one instruction and a review step.
4. No write happens without a preview and a confirmation.
5. No duplicate expense is created by a retry.

## Non-goals

- Moving money. Settle links open Venmo, PayPal, or a UPI intent. The server never holds funds.
- Deleting expenses, groups, or members.
- A general Splitwise API mirror.
- Public hosting.

## Personas

**The organizer.** Creates the group. Pays first. Wants speed at entry and cover when chasing.

**The participant.** Joins late. Wants to know their number, why it is that number, and one tap to pay.

**The couple.** Two people, one long-lived group, proportional splits. Wants the ledger to fade into the background.

## User stories

1. As an organizer, I say "dinner 84, I paid, split with everyone in Lisbon" and the expense is proposed, shown to me, and posted when I say yes.
2. As a participant, I ask "why do I owe Priya 61" and see the four expenses that make up the number.
3. As an organizer, I ask "who is late" and get a list with age and amount.
4. As an organizer, I say "close out Lisbon" and get the minimum set of payments with a link for each person.
5. As an organizer, I say "nudge Sam, gently" and see the draft before it posts.
6. As anyone, I import twelve expenses and the server tells me three look like duplicates before it posts any.

## Tool surface

Names follow the MCP naming rules. Every tool has an `inputSchema`, an `outputSchema`, and annotations.

### `explain_balance`

- Input: `group_id` or `friend_id`, optional `currency`.
- Output: net amount, direction, and a list of contributing expenses with each person's share.
- Annotations: read-only, idempotent.

### `stale_balances`

- Input: `older_than_days` (default 30), optional `group_id`.
- Output: list of balances with counterparty, amount, age in days, last activity date.
- Annotations: read-only, idempotent.

### `add_expense`

- Input: `text` or `receipt_image`, `group_id`, optional `date`, `currency`, `split_rule`.
- Step 1 returns `input_required` with the proposed expense: cost, payer, each person's share, category, and the sentence "This changes what A, B, and C owe."
- Step 2, after confirmation, writes the expense and returns the Splitwise expense id.
- Duplicate check runs before step 1. A likely duplicate is shown in the preview.
- Annotations: not read-only, not idempotent (the write log makes retries safe).

### `find_duplicates`

- Input: `group_id`, optional `since`.
- Output: groups of likely duplicates with a confidence and a suggested action.
- Merges happen only through a second call with confirmation. The tool never deletes. It updates one expense and marks the other with a comment, or asks the user to delete in the app.
- Annotations: read-only in step 1.

### `settle_plan`

- Input: `group_id`.
- Output: the minimum set of payments, each with payer, payee, amount, and a prefilled pay link where the market supports one.
- Checked against Splitwise's own simplified debts. Differences are shown, not hidden.
- Annotations: read-only, idempotent.

### `nudge`

- Input: `friend_id`, `tone` (gentle, plain, firm), optional `group_id`.
- Step 1 returns `input_required` with the draft.
- Step 2 posts the draft as a comment on the most recent shared expense, or as a Splitwise reminder where the API allows it.
- Annotations: not read-only.

### Resources

- `splitwise://groups`: id, name, type, members. `ttlMs` one hour.
- `splitwise://categories`: `ttlMs` one day.
- `splitwise://currencies`: `ttlMs` one day.

### Prompt

- `close_out_trip`: runs `find_duplicates`, then `explain_balance` for each member, then `settle_plan`, and ends with a summary the organizer can paste into the group chat.

## Flows

### Preview and confirm

1. The model calls a write tool.
2. The server computes the change and returns `resultType: "input_required"` with a plain-language preview and a `requestState`.
3. The client shows the preview. The user says yes or no.
4. The client retries the call with `inputResponses` and the same `requestState`.
5. The server validates the state, checks the write log, writes, and returns the result.

### Duplicate guard

1. Before any write, compute a fingerprint: group, rounded amount, date within one day, payer, normalized description.
2. If the fingerprint matches a completed write in the last 48 hours, refuse and show the existing expense.
3. If an `idempotency_key` is present and matches, return the original result without writing.

## Edge cases

- Multi-currency groups: never convert silently. Show the currency on every number.
- Members who have not joined yet: shares are allowed, but the preview says the person is pending.
- Deleted or left members: excluded from new splits, included in history.
- Rounding: splits must sum to the cost. The remainder goes to the payer.
- Ambiguous names: "Alex" matches two people. Return `input_required` with a choice.
- Rate limits: back off and tell the user in plain words.

## Success metrics

See `metrics.md`. The three headline numbers:

1. Preview accept rate on writes.
2. Duplicates blocked per hundred writes.
3. Median seconds from instruction to posted expense.

## Roadmap

- v1: six tools, stdio and hosted single-user, evals, conformance, CI.
- v2: multi-user OAuth with a token vault and allowlist, change notifications, tasks for long reconciliations.
- v3: receipt itemization App, webhooks when the protocol adds them.

## Open questions

- Does the Splitwise API expose a reminder endpoint, or is a comment the only channel for `nudge`?
- Can a receipt image be attached on `create_expense` through the API?
- What are the real rate limits? The docs say "lenient" and do not give numbers.
- Do UPI intents with a prefilled amount still open in the major apps? Test on real devices.
