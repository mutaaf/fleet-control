---
id: 0016
title: fleetctl doctor — one-shot install + ingest diagnostic
status: groomed
priority: P2
area: infra
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a new operator who just cloned fleet-control and ran `fleetctl serve`
but isn't seeing my projects show up — OR as a returning operator whose
ingest silently stopped after a macOS upgrade rotated some path — I want
to run `fleetctl doctor` and get a single screen of prescriptive checks
("✓ node version", "✗ project at ~/code/foo missing `agents.config.sh`,
fix: …", "✗ launchd plist not loaded, fix: launchctl load …"), so that
the first-five-minutes friction and the silent-stop friction both become
one loud command instead of a debugging crawl through three log files.

## Why now (four lenses)

### Product Owner
First-run failure and silent-ingest failure are the two biggest churn
vectors for a self-hosted tool. Today the operator has to know to look
at `~/Library/Logs/com.fleet.control.fleetd.err`, then guess whether
the launchd plist is loaded, then check that each project carries an
`agents.config.sh`. A single command that runs every known check, names
each failure mode, and prints the exact fix line collapses N silent
problems into one loud answer. It's also the cheapest possible smoke
test for the autonomous loop itself.

### Stakeholder
Widens the moat on `infra` by turning the local-first install — a
weakness compared to a hosted product's "click install" — into a
strength: the doctor command knows about the real filesystem and can
prescribe fixes a SaaS dashboard couldn't even diagnose. Also a forcing
function: every new failure mode discovered in production should land
a doctor check in the same PR, so the surface area of "things the
operator has to know" stays bounded.

### User (operator at 9am, looking at the portal)
`fleetctl doctor` prints one line per check, color-coded (green ✓, red
✗, yellow ⚠), grouped by category (runtime / config / discovery /
ingest / control / network). Each ✗ row is followed by an indented
"fix:" line with a copy-pastable command. Exits non-zero if any ✗.
Runs in under 2 seconds. Adding `--json` emits the same data as a
machine-readable report.

### Growth
The doctor command becomes the first thing the README tells you to run
after install, and the first thing every support thread asks for output
of. Every new failure mode discovered in the field grows the command
once, then never bites a new operator again. The doctor's JSON output
is also the foundation for a future "fleet-control is unhealthy" panel
in the portal.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/doctor.ts` (new) exports `runDoctor(opts)` returning
      `{checks: Array<{category, name, status: "ok"|"warn"|"fail",
      detail?: string, fix?: string}>, ok: boolean}`. Pure function over
      injected dependencies (fs, exec, db) so every check is unit-test
      able. `ok` is true iff every check is `ok` or `warn`. Test:
      stub each dependency, assert the structure and `ok` aggregation.
- [ ] Runtime checks: node version ≥ 23, `npx tsc --version` resolves,
      `sqlite_version()` returns. Each check has its own test with a
      stub that returns the failure case and asserts the `fix:` line
      names a concrete command (`brew upgrade node@23`, `npm ci`, etc).
- [ ] Config checks: `fleet-control.config.json` exists and parses,
      contains an admin token, gitignore covers it. Test: stub a
      missing file, assert ✗ + the fix line mentions
      `fleetctl init-config` (or the existing equivalent).
- [ ] Discovery checks: walk the configured project roots, for each
      directory matching the discovery glob assert that
      `agents.config.sh` is present and parseable; emit ⚠ for any
      root that contains zero matching projects. Test: stub a root
      with one valid project + one near-miss directory, assert two
      check lines with the expected statuses.
- [ ] Ingest checks: for each known project, look up the last
      `agent_event` row's timestamp; ✗ if no rows ever, ⚠ if the last
      row is older than 24h and the project's launchd plist is
      loaded. The fix line for the latter names
      `launchctl list | grep com.<slug>` and the `kickstart`
      invocation. Test: seed a db with one stale project, assert ⚠
      and the fix mentions `launchctl kickstart`.
- [ ] Control checks: `launchctl list | grep com.fleet.control` shows
      `fleetd` loaded; the admin daemon socket responds to a loopback
      `GET /api/health`. Test: stub each external call, assert the
      ✗ rows for each absent dependency.
- [ ] Network checks: `gh auth status` exits 0 (warn if 1 — the loop
      can still run without `gh` for projects that don't open PRs);
      `ntfy.sh` reachable if any project has push enabled (warn if
      not). Test: stub each, assert ⚠ vs ✗ per the spec above.
- [ ] `bin/fleetctl.ts` adds the `doctor` subcommand. Default output is
      human-readable (colored when stdout is a TTY, plain otherwise);
      `--json` emits the structured report. Process exit code is 0 if
      `ok`, 1 if any ✗, 2 if doctor itself errored. Test: invoke each
      shape via the test harness, assert exit code and stdout shape.
- [ ] Doctor runs in under 2 seconds on a fleet of 7 projects. Test:
      time the run against a stub fleet of 7, assert <2000ms (skip if
      `process.env.PERF !== "1"` to keep CI fast).
- [ ] Doctor MUST NOT print the admin token, repo URLs, or any
      `gh` PAT in either human or JSON output. Test: run against a
      config that contains a token, assert the token literal does not
      appear in either output.
- [ ] No new runtime deps. `tsc --noEmit` clean. All shell-out uses
      `execFile` with an argv array (per AGENTS.md — no shell-string
      composition).

## Out of scope

- Auto-fixing any of the diagnosed problems. Doctor reports and
  prescribes; the operator runs the fix. Auto-fixers are a future
  ticket once the read-only surface is stable.
- A portal UI for doctor output. The CLI is the v1 surface; a portal
  panel can ship as a separate ticket once `--json` is in production
  use.
- Cross-machine fleet doctor (i.e. diagnosing a remote operator's
  install). Local-only by design.
- Continuous health-monitoring or push-on-unhealthy. The daemon's
  existing anomaly / alert paths handle that.
- A doctor plugin system. Every check is hardcoded in v1; adding a
  check is a code change with a test.

## Engineering notes

- `src/doctor.ts` — new module. Each check is a small function
  returning the result object; `runDoctor` composes them in category
  order. The injected dependency surface (an interface with
  `exec(cmd, args)`, `readFile(path)`, `dbQuery(sql, params)`) makes
  every check unit-testable without spawning real binaries — same
  pattern as the runner seam from ticket 0010 (see
  `docs/LESSONS.md` § shell-out modules need an injectable runner).
- `bin/fleetctl.ts` — one new subcommand dispatch. Reuse the existing
  TTY-color helpers if present, otherwise inline a 10-line ANSI
  helper.
- `tests/doctor.test.ts` (new) — one `test()` per check function plus
  one integration test that runs the whole composition with a stubbed
  dep surface.
- No new runtime deps. No schema migration. No new `/api/...` route.
- Blocked-by: nothing. Cleanly orthogonal to the in-flight 0013 and
  0014 work.
- The structured `--json` output is forward-looking — once stable, a
  future portal ticket can render it as a "Health" panel without
  touching this module.

## Implementation log

(Appended by the implementation-dev agent during execution.)
