# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/cubinmark/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/cubinmark/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

The entry for make.fun's “Build a GitHub-compatible git forge” bounty. A standalone, single-process git forge in TypeScript (Node 22, standard library only, no dependencies): git smart HTTP (upload-pack protocol v2, receive-pack v0) for clone, fetch and push with an in-process git object model and packfile engine, the REST v3 API for repositories, contents, issues and pull requests, the GraphQL v4 API, and an MCP endpoint — all served from its own store, with no git binary and no outside service. Against the kit's own conformance environment it passes 120/120 checks.

## Run it

```sh
MAKEFUN_ENV_URL=<suite base URL> node main.ts   # binds an ephemeral port, registers with the suite, serves until /done
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=dnrr099a&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
