# PR/FAQ: Splitwise for AI agents

Draft in the Amazon working-backwards format. The press release is written as if for launch day. Edit in your voice before sharing.

---

## Press release

**Splitwise now works inside Claude and ChatGPT, so settling up takes one sentence**

PROVIDENCE, R.I. — Splitwise today launched the Splitwise connector for AI agents, available to Splitwise Pro members. People can now connect their Splitwise account to Claude or ChatGPT and say what they mean: "add dinner 84, I paid, split with everyone," "why do I owe Priya 61," "who's late," or "settle the Lisbon trip." Splitwise shows exactly who is affected, waits for a yes, and does the rest.

Splitwise keeps a fair record of shared money for tens of millions of people. Keeping that record has always fallen on one person per group: the one who types every expense into a form, explains the math when someone asks, and sends the awkward reminder. The connector takes those three chores off that person and leaves them the decisions.

"Splitwise exists to evaporate awkward conversations about money," said Jon Bittner, CEO and co-founder. "For fourteen years we did that with a ledger. Now the ledger can listen. Every change still shows who it affects and waits for you to say yes. Nothing is ever deleted. That is not a limitation. That is the product."

The connector offers six actions: explain a balance and the expenses behind it, find who is late, plan the minimum set of payments to close a group, spot duplicate expenses, add an expense from a sentence or a receipt, and send a reminder in a tone you pick. Every action that changes a balance shows a preview naming the people affected and posts only after confirmation.

"I organize every trip and I hated being the accountant," said an early tester. "Now I say what happened and it asks me once. My friends can ask it why they owe what they owe instead of asking me."

The Splitwise connector is available today for Splitwise Pro members in the Claude and ChatGPT connector directories. Learn more at splitwise.com/connect.

---

## Customer FAQ

**What can I do with it?**
Ask for your balance and see the expenses behind it. Ask who is late. Get the shortest list of payments to close a group. Find duplicates. Add an expense by describing it. Send a reminder in a tone you pick. Anything that changes a balance asks you first.

**Can it delete things?**
No. It never deletes an expense, a group, or a member. If something should go, you do it in the app.

**Can it move money?**
No. It plans payments and can record one you made. Paying still happens in Splitwise Pay, Venmo, PayPal, or your bank app.

**Will my friends see that an AI added something?**
Yes. Expenses show the app they came from, the same way they do today. Your group always sees the expense and can comment on it.

**What if it gets a split wrong?**
It shows you the split before posting and you say yes or no. If you say yes to something wrong, edit it in the app the way you would any other expense.

**What if someone in my group writes something sneaky in a comment?**
Text from your group is treated as information, never as an instruction. And nothing is written without your confirmation.

**Is my Splitwise password shared with the AI?**
No. You log in to Splitwise once, in Splitwise. The AI never sees your password or your Splitwise token. It only gets a limited connection you can revoke at Splitwise > Settings > Apps.

**Does it work outside the US?**
Yes. Everything except payment links works everywhere Splitwise does. Payment links follow the settle-up options in your country.

**How much does it cost?**
It is part of Splitwise Pro.

---

## Internal FAQ

**Why six tools and not the full API?**
The model picks tools from descriptions. Thirty endpoint mirrors force it to compose; six job-shaped tools let it act. The unofficial servers proved the mirror approach does not help people.

**Why preview-and-confirm on every write, even small ones?**
Every write changes other people's money. A wrong write is a social event. The preview names the affected people so the person confirming knows what they are agreeing to. Confirm rate is a primary metric, not friction to optimize away.

**Why no delete in v1?**
Deletion removes shared history for everyone. The useful jobs do not need it. The worst case of a bad run stays at "one extra visible expense."

**How do we handle the fact that our API tokens have no scopes?**
The connector's authorization server issues its own tokens with `read`, `add`, and `modify` scopes and enforces them per tool. The Splitwise token behind it is stored encrypted and decrypted only while serving that person's request. Longer term, scoped API tokens would let us drop that layer.

**What is the prompt-injection story?**
Descriptions, comments, and names come from other members and can carry instructions. The server labels fetched text as data, the model instructions repeat the rule, no tool can change the upstream host, and every write is confirm-gated. The eval set includes an injection case.

**What about duplicates?**
A per-user write log keyed by group, amount, day, payer, and normalized words refuses a repeat within 48 hours and returns the original result. Retries and second devices are the failure mode this closes. Splitwise-side near-duplicates are surfaced in the preview.

**How does this affect the free tier?**
It does not touch it. It is a Pro capability, which is a better Pro story than the daily cap.

**What are the launch gates?**
Compliance review of token custody and revocation. Connector directory approvals. Evals passing, including injection cases. Support runbook for "it said it posted but did not."

**What do we measure?**
Preview accept rate, duplicates blocked per hundred writes, seconds from instruction to posted expense, settle-ups started from agent sessions, Pro conversion from the listing, 90-day retention of connected users versus matched controls.
