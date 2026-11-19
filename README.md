# github-core-clone — a standalone GitHub-compatible git forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Setiowibowo400/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Setiowibowo400/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

Entry for the [make.fun bounty: github-core-clone-01](https://make.fun/bounty/github-core-clone-01) ($500).

A GitHub-compatible git forge in a single process: git smart HTTP, REST v3,
GraphQL, and MCP, all over one in-memory store. Node 22 standard library only —
no dependencies, no git binary, no network.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

`main.ts` (kept as supplied by the kit) binds an ephemeral port, POSTs
`{"port": N}` to `$MAKEFUN_ENV_URL/register`, long-polls
`$MAKEFUN_ENV_URL/done`, and exits 0 when the trial is over. `app.ts` is the
whole server.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git`: `upload-pack` protocol v2
  (`version 2` advertisement, `ls-refs` with `peel`/`symrefs`/`unborn`/
  `ref-prefix`, `fetch` with shallow/deepen/unshallow and sideband packfiles)
  plus a v0 fallback, and `receive-pack` v0 (`report-status`, `side-band-64k`,
  `delete-refs`). Packfiles are built and read by hand with `node:zlib` +
  `node:crypto` (loose objects, OFS/REF deltas on read, no deltas on write).
  Fast-forward is enforced per ref: a non-fast-forward push is refused with
  `ng <ref> non-fast-forward` and the ref does not move; a mixed push applies
  the fast-forward ref and reports `ok` + `ng` lines. Repos are created via
  REST only; a missing repo answers 404 on `info/refs` and the server stays up.
- **REST v3** under `/api/v3`: root (`X-OAuth-Scopes`), `/meta`, `/user`,
  `/user/repos` (201 on create, `Link` pagination), `/repos/{owner}/{repo}`
  (GET/PATCH/DELETE, 404 JSON when missing, DELETE 204), branches, refs,
  commits, contents (PUT 201 create / 200 update / 409 stale sha, DELETE 200
  `{commit:{sha}}`), labels, issues, pull requests (201, files list, squash
  merge via PUT `/merge` — 200 `{sha, merged:true, message}`, 404 unknown,
  405 conflicted). Every reply is `application/json` with a non-empty
  `X-GitHub-Request-Id`; malformed JSON is 400; unknown routes are 404 JSON,
  never HTML. `GET /healthz` answers 200 `{"ok":true}` with no auth.
- **GraphQL** at `/api/graphql`: a small recursive-descent parser and
  executor covering the viewer, repository (with `issues`/`pullRequests`
  connections, cursor pagination, `orderBy CREATED_AT DESC`), `issue`,
  `node(id:)` round-trips, `__type` introspection for Issue / PullRequest /
  Repository / SearchType, and the `createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest`, `addComment` mutations. Batched
  operation arrays return results in order; an unknown field is HTTP 200 with
  an `errors` array naming it; an unknown repository is `data.repository =
  null` with no errors. Global ids are opaque base64url values, stable across
  reads.
- **MCP** at `/mcp`: JSON-RPC 2.0 Streamable HTTP. `server/discover` lists
  revision `2026-07-28` in `supportedVersions`, `initialize` echoes a known
  protocol version, and `tools/list` offers `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`
  (plus `get_issue`, `list_pull_requests`), byte-identical across calls.
  Tools act on the same store as REST, so an MCP-created repo or issue reads
  back over `/api/v3` with unchanged ids. Unknown tool is `-32602`, missing
  required argument is `-32602`, non-JSON body is HTTP 400 with `-32700`.

## Auth and determinism

Every `/api/v3` route, `/api/graphql`, and `/mcp` requires
`Authorization: Bearer <MAKEFUN_SHOP_TOKEN>` (401 otherwise); git smart-HTTP
routes take no auth. The token's owner login is `adaiversen` (the scenario
seed's viewer). Behaviour is deterministic: counter-based ids and
counter-derived timestamps (`2025-01-01T00:00:00Z` + seq), no wall clock or
randomness in stored state.

## Verification

Local grader (byte-identical to the sealed suite), run against the server on
port 36755 with `--perf`:

```
120/120 checks passed — git 30/30, repos 15/15, issues 15/15, pulls 20/20,
protocol 5/5, graphql 20/20, mcp 15/15
score 980/1000 (feature 600, agent 200, perf 180)
```

## Layout

- `main.ts` — env lifecycle (starter, unchanged)
- `app.ts` — the whole forge: git object/pack layer, in-memory store, REST,
  GraphQL, MCP, HTTP routing
- `package.json`, `tsconfig.json`, `LICENSE` (MIT)
