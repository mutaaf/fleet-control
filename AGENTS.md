# AGENTS.md — fleet-control

This file is the **contract** between the autonomous loop and this repo. The
shared engine in `~/.local/share/agent-fleet/lib/` reads `agents.config.sh`;
the `claude` agent that runs each ship/groom/review cycle reads **this file**,
in a fresh checkout, every single time.

## What this repo is

`fleet-control` is the local control plane for the autonomous agent fleet —
a Node v23+ zero-dep app (TypeScript via type-stripping, `node:sqlite`,
`node:http`) that discovers projects by their `agents.config.sh`, ingests
transcripts, exposes a SPA portal + JSON API, and manages launchd jobs +
GitHub PRs.

The loop runs against this repo so the agents themselves improve the very
portal that watches them. Wiring details for the loop are below.

## Agent parameters

> Read by the shared `agent-fleet` runners at runtime. The one place the
> generic ship/groom/review prompts look for this project's specifics.

- **Gating checks** — EXACTLY these GitHub check names gate a merge. Every
  other check is informational and MUST be ignored when deciding mergeability
  or what to "fix":
  - `typecheck`
  - `validate`
- **Agent branch prefixes**:
  - `feat/` — feature work (ship agent)
  - `chore/gtm-` — backlog refresh (groom agent)
  - `eng/` — engineering work (eng agent, only if ENG_ENABLED)
- **Local gate command** — what the heal/dev step runs locally before pushing
  (must be green):
  `npm ci && npx tsc --noEmit && node scripts/check-backlog.mjs`
- **Subagents** (in `.claude/agents/`): `implementation-dev`, `gtm-innovation`,
  `review`
- **Backlog areas**: `ingest | portal | control | infra | observability | docs`
- **Backlog validator**: `node scripts/check-backlog.mjs` (wired into the
  `validate` gating job — keeps ticket files and the index in sync)

## Hard NOs

The reviewer treats any of these as an automatic `--request-changes`.

- Never push to `main` directly; never bypass branch protection; never merge
  with a red gating check.
- Never disable or weaken a passing typecheck. Fix the type instead.
- Never "fix" a non-gating check — ignore it.
- Never exceed 2 `heal:` attempts on one PR — escalate via a human comment.
- **Stay zero-runtime-dependency.** No new entries in `dependencies` (devDeps
  for tooling are fine). Lean on `node:sqlite`, `node:http`, the standard
  library. The portal SPA is vanilla — no React, Vite, or bundlers.
- Never widen the surface of `src/control.ts` actions beyond shell-out to
  `launchctl` / `gh` / `bash` with `execFile` + an argv array. Never compose
  a shell string from user input.
- Never log or commit the admin token (`fleet-control.config.json` is
  gitignored — keep it that way).
- Never break the JSON shape of an existing `/api/...` route without bumping
  a version in the path AND the SPA's fetch call together in one PR.
- Never `rm -rf` outside `~/.cache/<slug>-agent-*-checkout` or
  `~/.local/share/agent-fleet/` (the kit's TCC-safe install).
- Never commit values that look like API keys, tokens, or `gh` PATs.

## How the loop runs on this repo

- `ship` fires hourly at `:53`. It heals the in-flight PR if one exists,
  otherwise picks the top groomed ticket and ships it via `implementation-dev`.
- `groom` fires at `:07` on hours 3/9/15/21. It refreshes the backlog index
  and proposes new tickets via `gtm-innovation`.
- `review` polls every 5 min. When an open agent PR exists, it grades the
  diff against this file via the `review` subagent.

When changes land that touch `src/`, the running `fleetctl serve` process
needs a restart to pick them up. The `keep-running` flow in fleet-control
(when bumping SELF_CANCEL) handles this on the local side; the daemon's
launchd plist (com.fleet.control.fleetd) survives the restart.

## Local development (humans)

```
npm ci
npx tsc --noEmit
node scripts/check-backlog.mjs
node --disable-warning=ExperimentalWarning bin/fleetctl.ts serve
# open http://127.0.0.1:7070
```

For LAN access, set `FLEET_HOST=0.0.0.0`. The admin token in
`fleet-control.config.json` is auto-generated on first run; loopback bypasses
auth, remote requires `x-fleet-token`.
