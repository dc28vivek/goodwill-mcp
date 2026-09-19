# Marketing collateral

Drafts. Everything here is for the unofficial project unless marked "if official." Edit in your voice before publishing.

## Positioning

**For** the person who organizes the group and hates being its accountant,
**fairsplit** is a Splitwise connector for AI agents
**that** turns one sentence into a posted expense, a clear explanation, or a settle-up plan,
**unlike** the thirty API-mirror servers on GitHub,
**it** shows who is affected before anything changes, never deletes, and never posts twice.

## One-liners

- Say what happened. Splitwise gets it right. You confirm.
- The ledger can listen now.
- Explain, settle, remind. Never delete.
- For the friend who always pays and hates chasing.

## Connector directory listing (short)

**fairsplit for Splitwise (unofficial)**
Ask why you owe what you owe, find who is late, plan a settle-up, catch duplicates, add an expense in one sentence, and send a reminder in your tone. Every change shows who it affects and waits for your yes. Nothing is ever deleted. Not affiliated with Splitwise.

## Connector directory listing (long)

Splitwise keeps a fair record of shared money. Keeping it is work, and it falls on one person per group. fairsplit takes the typing, the explaining, and the chasing off that person.

Six actions:
- **Explain a balance.** The number and the expenses behind it.
- **Find stale balances.** Who is late, and by how long.
- **Plan a settle-up.** The fewest payments to close a group, checked against Splitwise.
- **Reconcile.** Likely duplicates with a confidence and a suggested action.
- **Add an expense.** "dinner 84, I paid, split with everyone." You see the split and who it affects. You confirm.
- **Nudge.** A reminder drafted in a gentle, plain, or firm tone. You confirm.

Safety is the product: every write previews and waits, text from other members is treated as data, a write log refuses duplicate posts, and nothing is ever deleted.

## Landing page copy

**Headline:** Settle up in one sentence.
**Sub:** Connect Splitwise to Claude. Say what happened. See who it affects. Say yes.

**Three columns**
1. *Explain.* "Why do I owe Priya 61?" Get the four expenses that make the number.
2. *Settle.* "Close out Lisbon." Get the shortest list of who pays whom.
3. *Remind.* "Nudge Sam, gently." See the draft. Post it as a comment.

**Trust strip:** Previews before every write. No deletes. No duplicate posts. Your Splitwise token stays encrypted. Revoke any time at Splitwise > Settings > Apps.

**Footer:** Unofficial. Not affiliated with Splitwise, Inc. Personal, non-commercial use under the Splitwise Developer Terms.

## Demo script (two minutes)

0:00 "This is a Lisbon trip group in Splitwise. Three people, four expenses, and I paid for all of it."
0:15 In Claude: "Any duplicates in Lisbon?" Show the reconcile result: none.
0:30 "Why does Priya owe me 61?" Show the two expenses behind it.
0:50 "Add coffee 10, I paid, split with me, Priya and Sam." Show the preview: the split, the sentence "This changes what Priya and Sam owe." Click yes. Show it in the Splitwise app.
1:20 "Add coffee 10 again." Show the refusal: already posted, nothing new created.
1:35 "How do we settle Lisbon?" Show two payments and "matches Splitwise."
1:50 "Nudge Priya, plainly." Show the draft, confirm, show the comment in the app.
2:00 "Six tools. Every write asks first. Nothing deletes. That's the whole idea."

## Launch thread (six posts)

1. I built an unofficial Splitwise connector for Claude. Not because Splitwise needs a 31st API wrapper, but because none of the 30 treat a write as what it is: a change to other people's money.
2. The customer isn't "the Splitwise user." It's the organizer. The one who types every expense, explains every balance, and sends every awkward reminder. Every top complaint on the feedback board is theirs.
3. So: six tools shaped like jobs. Explain a balance. Find who's late. Plan a settle-up. Catch duplicates. Add from a sentence. Nudge in your tone.
4. Every write previews who it affects and waits for a yes. A write log refuses double posts. Comments from other members are data, not instructions. And it never deletes. That last one is the point, not a gap.
5. Built on the 2026-07-28 MCP spec: stateless, multi round-trip confirmations, OAuth with our own scopes because Splitwise tokens have none. 55 tests, 14 evals, conformance suite, and a build log of every mistake.
6. Only Splitwise can ship the real one; their terms make sure of that. This is what I think it should look like. Repo and write-up: [link]

## If official: launch email to Pro members

**Subject:** Splitwise now works inside Claude

You can now connect Splitwise to Claude and say what you mean. "Add dinner 84, I paid, split with everyone." "Why do I owe Priya 61?" "Settle the Lisbon trip." Splitwise shows exactly who is affected, waits for your yes, and does the rest.

It never deletes anything. It never posts the same expense twice. Your friends see expenses the same way they always have.

Connect in Claude under Settings > Connectors. It is part of your Pro membership.
