# A GitHub-compatible git forge

A standalone, single-process git forge for
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01). It serves, from its own
in-memory store and with no dependencies beyond the Node standard library:

- **git smart HTTP** at `/<owner>/<repo>.git` — `info/refs`, `git-upload-pack` (protocol v2
  `ls-refs` and `fetch`, including shallow/deepen, plus a v0 fallback) and `git-receive-pack`
  (v0, with `report-status`, `side-band-64k` and `delete-refs`). The git object model, packfile
  reading/writing and the pkt-line protocol are implemented in-process on `node:crypto` and
  `node:zlib`; no `git` binary is ever invoked.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents, git refs, labels,
  issues, comments and pull requests (including squash merges), with GitHub-shaped objects,
  `Link`-header pagination and GitHub's status codes.
- **GraphQL v4** at `/api/graphql` — the queries and mutations `gh` and `github-mcp-server`
  send: viewer, repository fields, issue/pull-request reads and connections with cursor
  pagination, the create/close/merge mutations, Relay `node(id:)`, batching, and the
  introspection probes (`__type` fields and enum values).
- **MCP** at `/mcp` — JSON-RPC 2.0 over streamable HTTP: `server/discover` (revision
  2026-07-28), the legacy `initialize` handshake, and six tools (`create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) that act on the
  same store as REST.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry↔env lifecycle: bind an ephemeral port, `POST {"port": N}` to
`$MAKEFUN_ENV_URL/register`, poll `$MAKEFUN_ENV_URL/done`, exit 0 when the env says the trial
is over. The API token is read from `MAKEFUN_SHOP_TOKEN`; the login it names is the forge's one
user, and every repository belongs to that login.

## Layout

- `main.ts` — the lifecycle (bind, register, wait for done, exit 0).
- `app.ts` — the HTTP server: routing, auth, and the shared JSON plumbing.
- `store.ts` — the in-memory store: repositories, git objects, refs, issues, pull requests.
- `git.ts` — the git object model, packfiles, pkt-lines and the smart-HTTP protocol.
- `rest.ts` — the REST v3 surface.
- `graphql.ts` — a small GraphQL parser/executor and the forge's schema.
- `mcp.ts` — the MCP endpoint and its tools.
