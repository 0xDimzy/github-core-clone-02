# forge — a GitHub-compatible git forge, in-memory

A dependency-free TypeScript implementation of a GitHub-compatible git forge:
git smart HTTP (protocol v0 and v2, upload-pack and receive-pack), REST v3,
GraphQL v4, and MCP over JSON-RPC 2.0 — all served from one in-memory store.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port on 127.0.0.1, writes `server.toml`
(`port = <port>`), and — when `MAKEFUN_DONE_URL` is set — POSTs
`{port, url}` to that URL to register with the harness. With no harness
URL it prints the listening address and serves until killed.

Authentication is a Bearer token (`MAKEFUN_SHOP_TOKEN` when set; any
non-empty token otherwise). `GET /healthz` is unauthenticated.

## Layout

- `main.ts` — entrypoint: bind, write `server.toml`, register, serve.
- `net.ts` — a minimal HTTP/1.1 server over raw TCP (no `node:http`):
  keep-alive, Content-Length and chunked bodies, `Expect: 100-continue`.
- `app.ts` — request dispatcher: REST v3, GraphQL, MCP, git smart HTTP.
- `store.ts` — the in-memory store (repos, objects, issues, PRs, labels)
  plus the memoization caches.
- `gitcore.ts` — git object model, pkt-line codec, packfile read/write.
- `graphql.ts` — GraphQL parser + executor for the documents gh and
  github-mcp-server send.
- `mcp.ts` — MCP over JSON-RPC 2.0 (server/discover, initialize,
  tools/list, tools/call).

## Performance

Two things make this fast:

1. **Raw TCP transport.** Requests are parsed straight off the socket and
   each response is written as a single pre-built Buffer. No
   `node:http` request/response objects, no header object churn.
2. **Memoization.** Git objects are immutable, so commit/tree parses are
   cached per oid forever. Each repo carries a generation counter bumped
   on any mutation; response-level caches are keyed by it and can never
   go stale:
   - serialized REST issue/repo JSON (invalidated on mutation),
   - fetch packs keyed by (generation, plan) — a repeated shallow clone
     of the same tip is computed once, then served from cache,
   - v0 ref advertisements keyed by generation.

## Determinism

Ids and timestamps come from counters seeded at process start, never from
the wall clock or randomness, so a replay of the same request sequence
sees identical state.

## License

MIT — see `LICENSE`.
