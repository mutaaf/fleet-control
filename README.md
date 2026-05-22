# fleet-control

A local control plane for the autonomous agent fleet — **see, manage, and expand**
it from any device, without needing to know how agents/launchd/git work.

Standalone app (not part of `agent-fleet`) that points at folders you choose,
discovers fleet projects by their `agents.config.sh`, and reads everything from
**local files + launchctl + gh** — zero LLM calls, so it's cheap and fast.
History is cached in SQLite; live state is probed fresh. Plan:
`~/.claude/plans/floating-crunching-walrus.md`.

## Status — Phase 0 (data foundation) ✅

- Discovers projects + resolves legacy-slug aliases (`dca`→digitalcraft,
  `sportsiq`→courtiq) by git remote, so no history is lost.
- Backfills every historical run from Claude Code transcripts (+ token usage →
  estimated cost) and captures the full tool-call trace per run.
- Cost in tokens **and** estimated dollars (Max plan = no real bill; this is
  relative effort). Pricing is configurable in `src/pricing.ts`.

```bash
node --disable-warning=ExperimentalWarning bin/fleetctl.ts backfill   # ingest
node --disable-warning=ExperimentalWarning bin/fleetctl.ts status     # fleet cost board
node --disable-warning=ExperimentalWarning bin/fleetctl.ts runs <slug># recent runs
node --disable-warning=ExperimentalWarning bin/fleetctl.ts show <id>  # plain summary + trace
```

Requires Node ≥23 (runs TypeScript directly; uses built-in `node:sqlite`).

## Next phases

1. Live engine (now/last/next) + read API + web Home/Project overview.
2. Runner instrumentation (`runs.jsonl` via `--output-format json`) → measured cost.
3. Understand: activity + run detail + SSE live tail.
4. Act: run-now / pause / resume / keep-running / eng-toggle + LAN auth.
5. Work & PRs: backlog browser + "tell it what to build" + PR review/merge.
6. Expand: add-a-project (connect folder, scaffold).
7. Always-on daemon + alerts + spending view + polish.

## Stack

Node + TypeScript (run directly, no build) · `node:sqlite` (WAL) · (web portal:
React + Vite + TanStack Query, later). Server binds `127.0.0.1` by default; LAN
access (phone/tablet) is opt-in and requires an admin token.
