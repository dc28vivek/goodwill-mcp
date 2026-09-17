# ADR-0006: TypeScript, v2 MCP packages, Cloudflare Workers

Status: proposed

## Context

The server must implement the 2026-07-28 spec, run locally over stdio and remotely over Streamable HTTP, and host cheaply with a key-value store for the write log and token vault.

## Decision

TypeScript with the v2 `@modelcontextprotocol` packages. Cloudflare Workers for hosting, KV for the write log and token vault, `wrangler.toml` as the infrastructure definition.

## Alternatives

- Python with FastMCP. Strong OAuth proxy support, but container hosting costs more and the Workers path is less direct.
- A container on Fly or Railway. Kept as a fallback if Workers limits bite.

## Consequences

- One language for the server and the optional MCP App.
- Workers CPU limits may constrain receipt processing. Move that to a Task if it does.
