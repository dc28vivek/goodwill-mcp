# Build log

Every problem we hit, what caused it, and what we did. Newest at the bottom. This is the raw material for the retrospective.

## 2026-09-19

### The Splitwise OpenAPI file is a stub with $refs

`splitwise.yaml` on GitHub is 28 KB but only carries the intro, terms, and a handful of schemas. Paths and most schemas live in `paths/*.yaml` and `schemas/*.yaml` and are pulled in by `$ref`. Parsing the top-level file alone gave zero paths.

Fix: shallow-clone `splitwise/api-docs` and read the referenced files directly. Types in `src/splitwise/types.ts` were written by hand from them. The repo has no license file, so we do not vendor the YAML; we link to it.

### PyYAML was not installed

The system Python has no `yaml` module. `uv run --with pyyaml python3 -` runs a one-off with the dependency and no global install.

### The v2 SDK types are in a hashed chunk file

`@modelcontextprotocol/server/dist/index.d.mts` is a re-export list. The real declarations are in `createMcpHandler-<hash>.d.mts`. Grep that file for `registerTool`, `inputRequired`, `ServerOptions`, `BaseContext`.

Useful facts learned from the types, not from the docs:
- `registerTool(name, { title, description, inputSchema, outputSchema, annotations, icons, _meta }, cb)`. `inputSchema` must be a wrapped `z.object(...)`.
- A tool handler returns `CallToolResult | InputRequiredResult`. Build the latter with `inputRequired({ inputRequests: { key: inputRequired.elicit({ message, requestedSchema }) }, requestState })`.
- On retry, read answers with `acceptedContent(ctx.mcpReq.inputResponses, key, schema)`. Read verified state with `ctx.mcpReq.requestState<T>()`.
- `requestState` is attacker-controlled unless verified. `createRequestStateCodec({ key, ttlSeconds })` gives `mint` and `verify`; pass `verify` into `new McpServer(info, { requestState: { verify } })`. The key must be at least 32 bytes and shared across instances.
- Cache hints: `new McpServer(info, { cacheHints: { 'tools/list': { ttlMs, cacheScope } } })` and per resource `registerResource(name, uri, { cacheHint }, cb)`.
- `ctx.http?.authInfo` carries the verified bearer info in HTTP mode. `serveStdio` never sets it.
- `sampling`, `roots`, `logging`, and `ctx.mcpReq.elicitInput` are deprecated and throw on 2026-era requests.

### The SDK is a resource server only

`@modelcontextprotocol/server` verifies bearer tokens (`requireBearerAuth`) and serves metadata (`oauthMetadataResponse`). It never issues tokens. For a hosted multi-user server we need an authorization server. On Cloudflare that is `@cloudflare/workers-oauth-provider`, which supports RFC 9728 metadata and Client ID Metadata Documents. Decision recorded in ADR-0008; implementation is week 3.

### Parser: the participant list stopped at the first comma

`split between me, Sam and Alex` parsed as participants `["me"]` and description `groceries Sam and Alex`. The regex captured up to the first comma. Replaced it with a small name-list grammar: names separated by commas, `and`, or `&`.

### Explain: the sign on payments was inverted

For a payment expense the payer's `paid_share` is the amount. A payment from them to me lowers what they owe me, so the contribution is negative. The first version had it backwards; the fixture with Sam paying 49 back caught it. Rule now: `amount = me.paid_share - them.paid_share` for payments.

### Stale: day counts use floor, not round

44.2 days is 44 days. The test expectation was wrong, not the code. Kept floor because "older than 30 days" should mean a full 30 days have passed.

### exactOptionalPropertyTypes bites fetch init

With `exactOptionalPropertyTypes`, a `body` set to undefined is not assignable to `RequestInit.body`. Build the init object and set `body` only when there is one. Worth keeping the flag: it caught two more optional-field slips in the tool payloads.

### The codec's verify takes the request context too

`createRequestStateCodec().verify(state, ctx)` wants both arguments, and the `ServerOptions.requestState.verify` hook passes both. Wire it as `verify: (state, ctx) => codec.verify(state, ctx)`. The decoded payload the hook returns is what `ctx.mcpReq.requestState<T>()` gives the handler, so the tool reads verified state without a second decode.

### Heredoc rejected for control characters

A Bash heredoc that contained a unicode escape for the NUL character inside a regex was refused by the tool sandbox as hidden control characters. The escape sequence itself looked like a control character to the checker. Rewrote the regex with hex escapes for the 0x00 to 0x1f range and replaced a literal ellipsis with three dots. The same thing happened when writing this note the first time.
