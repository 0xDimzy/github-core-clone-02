# forge — a GitHub-compatible git forge, in-memory

A dependency-free Go implementation of a GitHub-compatible git forge:
git smart HTTP (protocol v0 and v2, upload-pack and receive-pack), REST v3,
GraphQL v4, and MCP over JSON-RPC 2.0 — all served from one in-memory store.
A from-scratch rewrite of the v3 Node.js forge (same behavior, same wire
format), built for lower per-request overhead: a raw TCP HTTP server, one
goroutine per connection, memoized fetch packs / ref advertisements /
serialized issue and repo responses.

## Run

```sh
node main.ts
```

`main.ts` is a thin wrapper that spawns the prebuilt `forge` binary beside
it and waits for it. The binary binds an ephemeral port on 127.0.0.1, writes
`server.toml` (`port = <port>`) in standalone mode, and — when
`MAKEFUN_ENV_URL` is set — POSTs `{port}` to `$MAKEFUN_ENV_URL/register`
and polls `$MAKEFUN_ENV_URL/done` until the trial ends, then exits 0.

Authentication is a Bearer token (`MAKEFUN_SHOP_TOKEN` when set; any
non-empty token otherwise). `GET /healthz` is unauthenticated.

## Rebuild

```sh
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o forge .
```

Go 1.25. The result is a statically linked Linux amd64 binary (~6.7 MB,
under the 8 MiB per-file cap). The v3 Node.js sources remain in this
directory (`*.ts`, entrypoint preserved as `main-v3.ts`) as the reference
implementation and fallback.

## Layout

- `main.ts` — entrypoint wrapper: spawns `./forge`, forwards signals.
- `main.go` — lifecycle: harness register/poll, standalone server.toml.
- `net.go` — a minimal HTTP/1.1 server over raw TCP (no `net/http`):
  keep-alive, Content-Length and chunked bodies, `Expect: 100-continue`.
- `app.go` — request dispatcher: REST v3, GraphQL, MCP, git smart HTTP.
- `store.go` — the in-memory store (repos, objects, issues, PRs)
  plus the memoization caches.
- `git.go` — git object model, pkt-line codec, packfile read/write.
- `graphql.go` — GraphQL parser + executor for the documents gh and
  github-mcp-server send.
- `mcp.go` — MCP over JSON-RPC 2.0 (server/discover, initialize,
  tools/list, tools/call).
- `json.go` — JSON body parsing / serialization helpers.

## Performance

Local conformance (`sdk/run.ts --perf`, 3 fresh-server runs): 120/120
checks, MCP 15/15, perf_p50_us 175,772–198,842 (median ~181k), vs the v3
Node forge's 187,329–203,904 (median ~191k) on the same machine — about 4%
faster on the suite's geometric mean, with larger server-side wins per op
(micro-benchmark: issue read 77 vs 98 us/op, issue write 99 vs 178 us/op,
info/refs 82 vs 182 us/op). The suite's own client dominates the remaining
wall time, so the suite-level gain is smaller than the server-side gain.

## Determinism

Ids and timestamps come from counters seeded at process start, never from
the wall clock or randomness, so a replay of the same request sequence
sees identical state.

## License

MIT — see `LICENSE`.
