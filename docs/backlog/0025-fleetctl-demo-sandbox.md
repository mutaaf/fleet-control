---
id: 0025
title: fleetctl demo - one-command sandbox boots portal against seeded fixture fleet
status: in-progress
priority: P1
area: infra
created: 2026-05-28
owner: gtm-innovation
---

## User story

As a curious developer who just heard about fleet-control on Hacker News
and wants to see what it actually does before cloning anything serious,
I want a single command - `node --disable-warning=ExperimentalWarning
bin/fleetctl.ts demo` - that boots the portal against a fixture fleet
of three seeded projects (transcripts, runs, anomalies, PRs all
pre-populated) and opens to a populated home page, so that the "is this
worth my Tuesday evening?" decision happens in 30 seconds instead of
"clone, register a real repo, wait for an agent run, hope it ingests".

## Why now (four lenses)

### Product Owner
The portal today is empty until the operator registers a project AND
waits for the daemon to ingest at least one run - somewhere between
60 seconds and "tomorrow morning" depending on the project's ship
cadence. That gap is where every prospective adopter bounces. A
sandbox mode that loads a deterministic fixture into an ephemeral DB
and serves the SPA against it converts the empty-portal moment into a
populated one without the operator owning any agent infrastructure
yet. One subcommand, zero side-effects on the operator's real DB.

### Stakeholder
Widens the moat on `infra` and acquisition. The kit's distinguishing
property is "clone, npm ci, npx fleetctl serve" - zero deps, zero
account. Sandbox mode makes that property *visible* on first contact:
the prospective operator sees the populated portal before they
register a single real project. Every other tool in the autonomous-
agent space gates a working demo behind a signup wall; this one
ships the populated screenshot in 30 seconds.

### User (operator at 9am, fresh clone)
`fleetctl demo` prints two lines and opens (or invites the operator
to open) `http://127.0.0.1:7071` - deliberately a different port from
the production `7070` so a real fleet running on the same machine
isn't shadowed. The portal shows three projects (`fleet-demo-api`,
`fleet-demo-web`, `fleet-demo-cli`), each with a coloured health dot,
recent runs, two merged PRs, one open agent PR with a `heal 1/2`
chip, one fired anomaly, a weekly digest with shipped tickets, an
inbox with two actionable items. Pressing Ctrl-C tears everything
down; the operator's real `~/.local/state/fleet-control/fleet.db`
was never opened.

### Growth
This is the single highest-leverage acquisition artifact in the
backlog. The README's "show me" GIF stops being a 30-second loop of
five mocked screenshots and becomes a 30-second screen recording of
`fleetctl demo` running for real. Show HN posts ship with the
command in the title. Friends who want to evaluate the tool run it
in their lunch break without owning an agent fleet.

## Acceptance criteria

Each box maps 1:1 to a test scenario. The dev agent writes the tests
against this list before writing code.

- [ ] `bin/fleetctl.ts` accepts a new `demo` subcommand. Running
      `fleetctl demo` boots the same `startServer()` path as `serve`
      but against an ephemeral SQLite DB (tmpdir, deleted on SIGINT)
      and a fixture-only config (empty `projectRoots`,
      `installedRoot`, `cacheBase` per LESSONS § "in-process
      startServer tests need an empty-roots config"). Test:
      `spawnSync` the CLI with `demo`, assert stdout includes the
      portal URL and that the server accepts a `GET /api/projects`
      returning the three demo projects.
- [ ] `src/demo/fixture.ts` (new) exports `loadDemoFixture(db)` that
      idempotently seeds three projects (`fleet-demo-api`,
      `fleet-demo-web`, `fleet-demo-cli`), 30 days of `run` rows
      across the ship/groom/review phases with realistic outcomes,
      a populated `cost_rollup_day` derived from those runs (per
      LESSONS § "depends on cost_rollup_day MUST seed through run
      rows"), 6 PR rows (4 merged, 2 open with one heal-attempted),
      one fired anomaly, and 8 backlog ticket links. Test: load the
      fixture twice into the same DB, assert row counts are
      identical (idempotent INSERT OR IGNORE, no duplicates).
- [ ] Fixture timestamps are computed relative to "now" at load
      time, NOT hardcoded - so the seeded runs always look "recent"
      no matter when the demo runs. Specifically: latest run is in
      the last 1h; oldest run is ~30 days ago; the open PR's
      `gh_created_at` is 4h ago; the anomaly fired 2h ago. Test:
      load the fixture, assert `MAX(run.ts) >= now() - 3600s` and
      `MIN(run.ts) >= now() - 30*86400s - 60s`.
- [ ] Demo mode binds to `127.0.0.1:7071` by default (not the
      production 7070), overridable with `--port=N`. The auth path
      is bypassed entirely in demo mode (loopback already bypasses;
      remote bind is refused with a one-line warning). Test:
      `GET /api/projects` over loopback returns 200 without a
      token; setting `FLEET_HOST=0.0.0.0 fleetctl demo` exits
      non-zero with stderr "demo mode refuses non-loopback binds".
- [ ] Demo mode disables ALL daemon side-effects: no `launchctl`
      calls, no `gh` ingest, no ntfy dispatch, no real
      `runIngestPass()` walk over the operator's filesystem. Test:
      stub the runner seam per LESSONS § "shell-out modules need an
      injectable runner from day one", boot demo for 5 seconds,
      assert zero `launchctl`/`gh`/`git` invocations.
- [ ] On SIGINT (Ctrl-C) the demo: (a) closes the HTTP server,
      (b) closes the DB handle, (c) `fs.rm`s the tmpdir, (d) exits
      0. Test: spawn the CLI, send SIGINT after the listening
      banner, assert exit code 0 and the tmpdir no longer exists
      on disk.
- [ ] Console banner: on listen, demo prints exactly:
      ```
      fleet-control demo - sandbox fleet at http://127.0.0.1:7071
      Three seeded projects, ephemeral DB. Press Ctrl-C to tear down.
      ```
      No more, no less. Test: snapshot the stdout banner against
      this fixture string.
- [ ] The fixture data MUST NOT contain any real GitHub URLs, real
      paths from the developer's machine, or any token-shaped
      substring. Per LESSONS § "defence-in-depth secret redaction
      at the renderer boundary" the fixture is still piped through
      `redactSecrets` as a backstop. Test: grep the rendered home
      payload for `gh[opusr]_`, real homedir substrings, and the
      developer's actual git config email - assert none appear.
- [ ] Determinism: a second `fleetctl demo` invocation against a
      fresh tmpdir produces a byte-identical `GET /api/projects`
      response (modulo timestamps which are recomputed - assert
      the structure-minus-timestamps is stable). Test: boot twice,
      diff the structural shape, assert equal.
- [ ] No new runtime deps. `tsc --noEmit` clean. No JSON-shape break
      to any existing `/api/...` route - the demo path reuses the
      production server with a different DB and config. No shell-
      string composition; no `dependencies` entry added.

## Out of scope

- A hosted demo on a public URL. The whole point is "runs on your
  laptop with no SaaS hop" - that's the moat. If a hosted version
  ever ships, it's a separate ticket and explicitly uses the same
  fixture loader.
- Interactive walkthroughs / coachmarks inside the SPA. The portal
  itself is the demo; an overlay tour is a separate ticket.
- A `--seed=<json>` flag for custom fixture data. The v1 fixture is
  fixed - that's what makes the "show me" stable across operators.
- Recording / replay of real fleets into a fixture. A future ticket
  could add `fleetctl demo from <real-db>` with anonymization; the
  shareable-snapshot work (0013) is closer to that already.
- A `npx fleetctl demo` zero-clone path. Would require publishing to
  npm with a runtime dep on the demo fixture; deferred until the
  zero-dep contract for npx publishing is figured out.

## Engineering notes

- `bin/fleetctl.ts` - new `demo` case in the subcommand switch. The
  call is small: derive a tmpdir, call `loadConfig({demo: true})` or
  pass a synthesized config, set `FLEET_DB_PATH` to the tmpdir DB,
  call `startServer()`, hook SIGINT to clean up. Per LESSONS § "CLI
  subprocess tests need a FLEET_DB_PATH env seam", reuse the same
  env-var path the existing tests already exercise.
- `src/demo/fixture.ts` - new module. Pure SQL inserts only - no
  shell-out, no network. Use `INSERT OR IGNORE` keyed on the natural
  primary keys so re-running is idempotent. Use the `as unknown as
  RowT[]` cast for any reads per LESSONS § "node:sqlite's .all()
  needs as unknown as T[]".
- `src/server.ts` - add an `opts.demoMode` flag that the demo
  subcommand passes through. When set, the daemon-tick wiring in
  `startServer()` skips the ingest/launchctl/gh paths. Keep the
  flag scoped tight - it must not leak into production codepaths;
  the simplest shape is a parameter to `startServer()` that defaults
  to `false`.
- `src/daemon.ts` - early-return guard at the top of the tick when
  `demoMode === true`. One-line change; do not branch deeper.
- Fixture data is hand-authored TypeScript constants (a few hundred
  rows total). No file I/O at fixture-load time - the data is in
  the module's source so type-stripping catches typos at boot.
- The banner string lives in `src/demo/fixture.ts` exported as a
  const so the test can snapshot it without duplicating the text.
- Pairs with 0024 (first-run welcome) - the welcome's line 1 could
  grow a "Just want to look around? Try `fleetctl demo`" hint, but
  that's a separate ticket. Pairs with 0013 (shareable snapshots) -
  the snapshot anonymizer's slug-mangler could feed the demo
  fixture's project names if we ever want them auto-rotated; not v1.
- No new runtime deps. The fixture is a few hundred bytes of TS
  literals; no JSON file, no template engine, no fixture loader
  library.

## Implementation log

- 2026-05-28: implementation-dev started on `feat/0025-fleetctl-demo-sandbox`.
  Plan: add `src/demo/fixture.ts` with hand-authored TS constants for three
  projects + 30 days of runs + PRs + anomalies (all timestamps relative to
  load-time); thread an `opts.demoMode` flag through `startServer()` and the
  daemon tick so no ingest/launchctl/gh side-effects fire in demo mode; add
  a `demo` subcommand to `bin/fleetctl.ts` that picks a tmpdir DB, plants
  an empty-roots config, calls `startServer(host, port, {demoMode: true})`,
  and tears everything down on SIGINT.
