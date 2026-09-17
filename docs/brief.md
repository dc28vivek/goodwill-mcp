# Product brief

Status: skeleton. Write every section in your own words. The bullets under each heading are the evidence and the argument to draw from, not the text.

One page. Eight short paragraphs. Read it aloud before you send it.

## 1. The customer

- Splitwise has tens of millions of registered users across four group types: Trip, Home, Couple, Other.
- Inside every group there are two roles. The organizer creates the group, enters most expenses, fronts money, explains the math, and chases. The others want to know their number and pay.
- Almost every complaint in `research/user-voice.md` is an organizer complaint.

## 2. The problem

- Entry is a form every time. Explaining a balance is done by hand. Chasing is a social cost the organizer pays.
- Quote one user on each. The three best are marked in `research/user-voice.md`.

## 3. Why an AI connector, and why now

- Thirty unofficial Splitwise MCP servers were built in fifteen months. Demand is proven. See `research/teardown.md`.
- None are usable by a normal person. All are API mirrors. Almost none treat writes as dangerous.
- The MCP spec matured in July 2026. A remote server is now an ordinary stateless HTTP service behind OAuth. The hard part moved from plumbing to trust. See `research/mcp-state-2026.md`.
- Splitwise's API terms forbid commercial third-party use. Only Splitwise can ship the real one.

## 4. The bet

- Six job-shaped tools, not thirty endpoints.
- Every write previews who it affects and waits for a yes.
- Text written by other group members is treated as data, never as instructions.
- No delete in v1.

## 5. What was built

- One or two sentences per tool. Link the demo video.
- State the stack in one line: TypeScript, 2026-07-28 spec, Streamable HTTP, OAuth, Cloudflare Workers.

## 6. What we measured

- Pull the numbers from `metrics.md` once the prototype has run: preview accept rate, duplicates blocked, seconds to log, settle-ups started.
- Say what surprised you.

## 7. Risks

- Token custody: Splitwise tokens have no scopes and never expire.
- Prompt injection through comments written by other members.
- The terms wall means this stays a prototype.

## 8. What Splitwise should do

- Ship an official connector as a Pro feature.
- Which three things from this prototype it should keep, and which one it should not.
