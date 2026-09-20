# Threat model

Status: draft. Update as the build makes choices concrete.

## Assets

1. Splitwise access tokens. No scopes. No expiry. Full account access.
2. Shared financial history: expenses, balances, comments, names.
3. The integrity of other people's balances.

## Actors

- The user, through an MCP client.
- Other group members, who write text the server fetches.
- A stranger who finds the server URL.
- A malicious or confused model.

## Threats and controls

| Threat | Control |
|---|---|
| Token theft from the server | Encrypted vault, secrets in platform secret storage, never in logs or responses. Client receives only a short-lived reference token. |
| Token misuse by the model | The model never sees the token. Tools choose an API path, never a host or a credential. |
| Prompt injection through comments or descriptions | Fetched text wrapped as data. Preview and confirm on every write. Injection cases in the eval set. |
| People not knowing what they granted | `/authorize` shows what a Splitwise token actually is (no scopes, no expiry) and how to revoke it, before anyone is sent to Splitwise. Opening the server to anyone needs an explicit `*`, so an emptied config locks the door rather than removing it. |
| Replay of a sign-in link | The OAuth state is signed and carries the hash of an HttpOnly cookie set at `/authorize`, so it works in one browser and once. Without it a self-contained state is replayable for its whole life, which allows binding someone's client to an attacker's Splitwise account. |
| Duplicate or runaway writes | Per-user write log with idempotency keys, reserved atomically before the upstream call. Per-user token bucket. No delete. |
| Telemetry leaking user data | Traces carry a fixed allowlist of attribute keys, and values are reduced to an identifier-safe alphabet. Paths are route templates, so no expense, group or person id is exported. |
| Retry storms during an upstream outage | Circuit breaker per isolate: refuse quickly rather than have every client retry a service that is trying to recover. |
| Stranger connects to the hosted server | OAuth required. Email allowlist. Each user can only reach their own data. |
| SSRF through tool arguments | Upstream host fixed in code. Inputs validated against schemas. |
| Data in logs | No expense text, names, or amounts in logs. Hashed user and group ids only. |
| Wrong split posted to a group | Money in minor units, exact-sum check, preview names affected people. |
| Revocation | Users revoke at Splitwise > Settings > Apps. The server drops the token on the next 401. |

## Out of scope for v1

- DPoP and agent identity. Track the MCP roadmap.
- Moving money. The server never holds funds.

## Reporting

Open a private issue or email the maintainer. Do not post tokens or account data.
