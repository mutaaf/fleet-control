---
id: 0046
title: fleetctl onboard wizard - one command from zero-state to first ingested project in under three minutes
status: shipped
priority: P1
area: infra
created: 2026-06-09
owner: gtm-innovation
---

## User story

As a friend of the operator who just cloned fleet-control after
seeing a screenshot, with zero projects ingested, no daily
budget, no quiet hours, and no phone paired, I want to type
`fleetctl onboard` and have ONE interactive flow walk me through
detecting any local agent projects, optionally importing one via
its GitHub URL, setting a soft daily budget, picking a quiet-
hours window, pairing my phone via a printed QR, and ending
with the LAN portal URL and the first-run welcome checklist
already populated - so that in under three minutes I'm looking
at a live portal with at least one project's data flowing in,
without having read README.md or memorised the seven other
subcommands.

## Why now (four lenses)

### Product Owner
Every onboarding primitive is already shipped, scattered across
seven subcommands and the first-run welcome banner. A fresh
operator today has to: read README, run `fleetctl serve`, see
the welcome checklist (0024), figure out which projects are
agent-enabled, run `fleetctl register-url <gh-url>` per project
(0010), open the portal, navigate to settings to set a budget
(0021), navigate again for quiet hours (0030), scan the printed
ASCII QR (0032), and finally open the LAN URL on phone. That's
~7 context switches and is the single biggest reason a screenshot
viewer never becomes a user. ONE subcommand that composes the
existing primitives in order, asks one question at a time, and
prints a single closing summary collapses the funnel. Pure
composition - no new schema, no new ingest path, no new control
surface. The smallest meaningful unit of value: a fresh `git
clone && npm ci && node bin/fleetctl.ts onboard` lands the
operator on a live portal with one project ingested, one budget
set, one quiet-hours window saved, and the QR printed - in one
flow.

### Stakeholder
Widens the moat on the acquisition + portability axis. The
zero-runtime-dep, local-only, "your friend can clone and run"
property is the moat - but only if "clone and run" actually
ends in a populated portal. Today it doesn't; the cost of the
seven-step gauntlet is invisible to existing operators but
fatal to new ones. The composed wizard is the surface that
proves the moat. Per the cross-fleet courtiq lesson "the
share-worthy moment is when a fresh clone gets to value in
one command" (the same shape as `fleetctl demo` from 0025,
but for REAL data not seeded fixtures), this is the missing
piece between "the demo looks great" and "I'm using it on my
own projects." No GitHub-native or Anthropic-dashboard
competitor has a "one command, real projects, three minutes"
onboarding because none of them are local-first. The
screenshot worth sharing: a terminal recording showing the
seven prompts answered in under three minutes, ending with
the operator's actual project page already populated.

### User (operator at first-clone, terminal in front of them)
At the terminal, after `npm ci`:

<!--
$ node bin/fleetctl.ts onboard

  Welcome to fleet-control. This will walk you through
  setting up your first project. About 3 minutes.

  Step 1/6  Detect local projects
    Scanning ~/dev for agents.config.sh ...
    Found 2: courtiq, almanac
    [a] add all   [s] skip   [pick which? 1,2]: a
    -> 2 projects registered.

  Step 2/6  Import from GitHub URL (optional)
    Paste a GitHub URL (or ENTER to skip): <ENTER>
    -> skipped.

  Step 3/6  Daily budget (autopause if blown)
    Soft daily $ cap per project [$2.00]: 3
    -> $3.00/day. Projects will autopause at the cap.

  Step 4/6  Quiet hours (suppress non-critical pushes)
    From [22:00]: <ENTER>     To [07:00]: <ENTER>
    -> 22:00 to 07:00 local.

  Step 5/6  Pair your phone
    LAN URL: http://192.168.1.42:7070
    Token:   fxxxx-xxxx-xxxx (revealed once)

    [ASCII QR for http://192.168.1.42:7070?token=... ]

    Scan with your phone, or hit ENTER to skip.

  Step 6/6  Open the portal
    Portal: http://127.0.0.1:7070
    Welcome checklist: 5/5 done.

  You're set. fleetctl serve is now running in the background.
  Stop it with: fleetctl stop
-->

The wizard is a pure stdin/stdout flow - no GUI, no browser
hand-off. Every step has a sensible default so the operator
can ENTER through anything they don't care about and still
end at a working portal. Every step is also skippable, so a
re-runner who already has 4 projects and a budget can
`fleetctl onboard --skip detect,budget` to just re-pair the
phone. Errors at any step (e.g. no LAN IP detected) print a
one-line apology and continue rather than aborting the flow.

### Growth
This IS the acquisition surface. Today the README is the
funnel; tomorrow the funnel is one line of shell. The
"show me" pitch: "clone the repo, npm ci, run one command -
three minutes later you have a portal watching your real
projects." The terminal recording that demonstrates this is
the single most shareable artifact fleet-control can
produce, second only to the live portal itself. Per the
cross-fleet courtiq lesson "the share-worthy moment is the
opinionated default that just works," the wizard's sensible
defaults at every step (detected projects, $2/day, 22:00-
07:00, LAN auto-detect) are the kind of opinionated
surface that makes a prospective adopter say "they thought
about this for me."

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE:
when this spec names a column value literally or a config
field, the implementing dev MUST grep `src/ingest/*.ts`,
`src/control.ts`, `src/config.ts`, and `bin/fleetctl.ts` for
the producer's actual spelling and shape before writing the
SELECT or the writer. Per LESSONS 2026-06-05 "groomer prose
can disagree with the schema; the schema wins": the existing
code is the contract. Specifically: the daily-budget shape
shipped by 0021 lives in a specific column on `project`
(grep for `daily_budget_usd` or similar) and the quiet-hours
window shipped by 0030 lives in `fleet-control.config.json`
under a specific key (grep for `quietHours`); the wizard
must write to those exact targets, never invent a parallel
storage.

- [ ] `bin/fleetctl.ts` registers a new `onboard` subcommand.
      `node bin/fleetctl.ts onboard` runs the interactive
      flow in AC2 through AC8. `--skip <list>` accepts a
      comma-separated list of step names (`detect`,
      `register-url`, `budget`, `quiet-hours`, `pair`,
      `open`) and skips those steps. `--non-interactive`
      (alias `--yes`) accepts every default with no prompts
      (used by the AC11 test). `--help` prints a short
      summary of the steps + flags. Per LESSONS 2026-05-29
      "when a CLI subcommand adds boot output, take
      ownership of the listen banner" - the onboard
      subcommand owns its full stdout (no double banner).
      Test: `--help` exits 0 with the step list in stdout;
      `--non-interactive` runs every step to completion
      with defaults; `--skip detect,pair` runs only the
      remaining four steps.
- [ ] Step 1/6 - **detect**: scans the operator's project
      roots (the same roots `runIngestPass` walks - read
      from `loadConfig().projectRoots`) for directories
      containing an `agents.config.sh` file. Lists each
      found project's slug (basename) and asks the
      operator to pick `a` (add all), `s` (skip), or a
      comma-separated index list (`1,3`). The chosen
      projects are registered via the SAME helper
      `register-url` and friends use today (do NOT write
      to the DB directly - go through the existing
      ingest registration path so the wizard inherits
      every existing safety check). If zero
      `agents.config.sh` files are found, the step
      prints "No local agent projects detected. Skip to
      step 2 to import from a GitHub URL." and proceeds
      without error. Per LESSONS § "shell-out modules
      need an injectable runner for tests", the detector
      takes the project-roots list as an argument and
      the wizard's main function takes an injected
      `deps` surface (stdin reader, stdout writer,
      config loader, registration helper) so tests can
      stub each. Test: stub a tmpdir with 2
      `agents.config.sh` files, drive the wizard with
      `a`, assert both projects are registered; stub
      empty tmpdir, drive the wizard, assert the
      "no projects" line and proceed.
- [ ] Step 2/6 - **register-url**: prompts for an
      optional GitHub URL. If the operator enters one,
      pipe it through the SAME helper 0010's
      `register-url` subcommand calls (do NOT
      duplicate the URL validation, clone logic, or
      scaffold step - reuse the existing
      `registerProjectFromGitHubUrl(url, deps)` helper
      from 0010, or whatever name it exports). On
      ENTER, skip. On invalid URL, print the error and
      re-prompt up to 3 times before skipping. Per
      LESSONS § "node:sqlite's .all() needs `as
      unknown as T[]`", every row narrowing uses the
      double-cast (if any read paths). Test: stub the
      0010 helper, drive the wizard with a valid URL,
      assert the helper was called with the URL; drive
      with ENTER, assert the helper was NOT called;
      drive with `garbage`, assert the re-prompt fires
      and the helper was NOT called after 3 retries.
- [ ] Step 3/6 - **budget**: prompts for a soft daily
      $ cap (default $2.00). PRODUCER-VS-SPEC NOTE:
      grep `src/control.ts` and `src/db.ts` for the
      actual column name on `project` that stores the
      0021 daily budget (e.g. `daily_budget_usd`,
      `budget_daily_usd`, etc.) and the helper that
      writes it - reuse that helper rather than
      composing the UPDATE here. The cap is applied to
      EVERY registered project (the wizard sets the
      fleet default; per-project tweaks live on the
      project page). On invalid input (non-numeric,
      negative), re-prompt up to 3 times then accept
      the default. Test: stub two registered projects,
      drive with `3`, assert both projects' budget
      column is `3.00`; drive with ENTER, assert both
      are `2.00`.
- [ ] Step 4/6 - **quiet-hours**: prompts for a start
      time (default `22:00`) and end time (default
      `07:00`) in `HH:MM` 24h format. PRODUCER-VS-
      SPEC NOTE: grep `src/config.ts` and any quiet-
      hours getter for the exact key under
      `fleet-control.config.json` that 0030 reads -
      reuse it. The wizard writes the chosen window to
      that key (preserving any other config keys
      already in the file via a read-merge-write
      sequence; NEVER overwrite the whole file). Per
      LESSONS § "in-process startServer() tests need
      an empty-roots config + run-row seeds", the test
      plants a tmp `fleet-control.config.json` in cwd
      and restores on cleanup so the dev's real config
      isn't clobbered. Per LESSONS 2026-05-25 "store
      cascading config values shaped to the reader" -
      the wizard writes the value in the EXACT shape
      0030 already reads, NEVER a parallel shape.
      Invalid input re-prompts up to 3 times then
      accepts default. Test: drive with `23:00`,
      `06:00`, assert the config file has those
      values under the 0030 key AND any prior config
      keys are preserved; drive with ENTER, assert
      `22:00`/`07:00` saved.
- [ ] Step 5/6 - **pair**: detects the LAN IP via the
      same helper 0032 uses (grep for the existing
      LAN-IP detection function; reuse it). Prints the
      LAN URL + the admin token (revealed ONCE -
      reuses 0003's existing token mint helper if a
      fresh token is needed, otherwise reads the
      existing token from `fleet-control.config.json`
      and prints it with the standard "this is your
      ONLY chance to see this" warning). Then renders
      the ASCII QR via the same 0032 helper, encoding
      `<LAN-URL>?token=<token>`. If no LAN IP can be
      detected (loopback only), prints "Could not
      detect a LAN IP. Skip phone pairing for now;
      you can re-run `fleetctl pair` later." and
      proceeds without error. Per LESSONS § "defence-
      in-depth secret redaction at the renderer
      boundary", any other operator-visible string
      passes through `redactSecrets` (the token line
      is the ONE exemption - it is the value being
      printed; the redactor MUST NOT redact the line
      it's intentionally rendering). Test: stub the
      LAN-IP helper to return `192.168.1.42`, drive
      ENTER, assert the QR ASCII appears in stdout
      AND the LAN URL line is present; stub the
      helper to return null, assert the "could not
      detect" line and proceed.
- [ ] Step 6/6 - **open**: if `fleetctl serve` is not
      already running (check via the same liveness
      probe `fleetctl doctor` uses - grep
      `src/doctor.ts` for the helper), start it in
      the background via the same launchd / nohup
      path the existing `fleetctl install` uses (do
      NOT re-implement the daemonisation). Print the
      loopback URL + a one-line summary "<N>
      projects registered. Welcome checklist <X>/<Y>
      done." where the checklist progress is read
      via the same helper the 0024 welcome banner
      uses. The wizard does NOT itself render the
      checklist - it just reports the count. Test:
      stub the serve-running probe to return false,
      drive the step, assert the start helper was
      called with the expected args; stub the probe
      to return true, drive the step, assert the
      start helper was NOT called and the URL +
      summary still print.
- [ ] Idempotency: re-running `fleetctl onboard`
      after a previous successful run detects the
      already-registered projects (Step 1 lists them
      with a "(already registered)" tag and offers
      `add new only`), reads the existing budget
      (Step 3 shows it as the default), reads the
      existing quiet-hours window (Step 4 shows it
      as the default), reads the existing token
      (Step 5 prints it again only if the operator
      types `show` at a "Reveal token?" prompt -
      otherwise just prints the QR pointing at the
      existing token). Re-running with
      `--non-interactive` is a no-op (every default
      is the current value). Per LESSONS § "in-
      process dedup sets need an explicit reset hook
      for tests", any module-level state the wizard
      keeps for "have I run before in this process"
      MUST expose `_resetOnboardForTests()`. Test:
      drive the wizard twice in the same process,
      assert the second pass detects the prior
      state at each step.
- [ ] Step-by-step skipping: `--skip <list>`
      accepts the six step names. Skipped steps
      print "Step <N>/6 <name>: skipped (--skip)."
      and continue. The end-of-wizard summary lists
      which steps ran and which were skipped. Test:
      `--skip detect,pair`, assert those two steps
      print the skipped line and the others run.
- [ ] LESSONS-shaped tests for the wizard wrapper:
      `--non-interactive` against a tmpdir with no
      `agents.config.sh` files, no GitHub URL given,
      default budget, default quiet hours, no LAN
      IP - the wizard MUST complete with exit 0 and
      a stdout summary that reads "<X>/6 steps
      completed" (any skips counted). This is the
      single load-bearing "happy-path-but-empty"
      test that proves the wizard never aborts on
      empty input. Per LESSONS § "anomaly tests
      need sigma > 0 in the fixture" - parallel
      lesson: the test fixture must EXERCISE every
      branch's empty-input path so a future
      regression that aborts on (say) "no LAN IP"
      is caught noisily. Test: as described.
- [ ] CLI subprocess test (per LESSONS 2026-05-26
      "CLI subprocess tests need a FLEET_DB_PATH
      env seam"): spawn `node bin/fleetctl.ts
      onboard --non-interactive` via `spawnSync`
      against a tmpdir DB (`FLEET_DB_PATH=
      <tmpdir>/fleet.db`), with a planted tmp
      `fleet-control.config.json` in cwd. Assert
      exit 0, stdout contains "You're set" (or the
      final-summary marker), and the tmpdir DB has
      the expected registered-project rows. Per
      LESSONS § "in-process startServer() tests
      need an empty-roots config + run-row seeds",
      the planted config points
      `projectRoots`/`installedRoot`/`cacheBase`/
      `claudeProjects` at empty tmpdirs and is
      restored on cleanup.
- [ ] No new runtime deps. `tsc --noEmit` clean.
      No shell-string composition (any shell-out
      goes through `execFile` with an argv array,
      per AGENTS.md Hard NO). No JSON-shape break
      to any existing `/api/...` route - the
      wizard is CLI-only, no HTTP surface. No
      schema migration - composes existing
      `project`, `auth_token`, and config-file
      writers. Per LESSONS § "no backticks inside
      template-literal SQL strings", any SQL the
      wizard touches keeps identifiers plain. Per
      LESSONS § "don't fake a lazy require in an
      ESM file; just import", every helper is
      imported at the top of `src/onboard.ts`.

## Out of scope

- A web-based onboarding flow (a `/onboard` route in
  the portal). v1 is terminal-only; the audience is
  someone who already has a terminal open after
  `npm ci`.
- Auto-launching the operator's browser at the LAN
  URL on completion. The wizard PRINTS the URL; the
  operator opens it (avoids fighting the OS's
  default-browser handling).
- A `fleetctl onboard --reset` that tears down the
  prior state. The wizard is additive; resets live
  in `fleetctl uninstall` (which already exists).
- Auto-detecting GitHub repos in `~/dev` and
  importing them without asking. Step 1 detects
  ONLY directories with an `agents.config.sh`
  (the explicit agent-enabled signal); GitHub
  import is opt-in via Step 2.
- An LLM-authored "tell me about your projects"
  step. The wizard is fixed prompts only - no
  runtime LLM calls.
- A `fleetctl onboard --import-from-config <path>`
  that reads a YAML/JSON file of pre-answered
  prompts. The CLI flag set (`--skip`,
  `--non-interactive`) is sufficient; a config
  file invites format bikeshedding.
- ntfy / push integration in the wizard itself.
  Phone pairing (Step 5) is the surface; push
  setup lives in the portal once the operator
  arrives.
- A "verify your install" health check at the end
  (`fleetctl doctor` already covers this and is
  printed in the closing line as a suggestion if
  any step encountered a soft error).

## Engineering notes

- `src/onboard.ts` (new) - exports `runOnboard(deps:
  OnboardDeps): Promise<{steps_run: string[],
  steps_skipped: string[]}>` where `OnboardDeps`
  carries the injected surfaces: `stdin` (a
  readline-style line reader), `stdout` (a writer),
  `loadConfig`, `saveConfig` (read-merge-write into
  `fleet-control.config.json`), `detectLocalProjects`
  (the agents.config.sh scanner),
  `registerLocalProject`, `registerFromGitHubUrl`
  (reuses 0010 helper), `setProjectBudget` (reuses
  0021 helper), `setQuietHoursWindow` (writes the
  0030 config key), `detectLanIp` (reuses 0032
  helper), `renderAsciiQr` (reuses 0032 helper),
  `mintOrLoadToken` (reuses 0003 helper),
  `isServeRunning` (reuses 0016 doctor probe),
  `startServeInBackground` (reuses
  `fleetctl install` daemonisation). Per LESSONS §
  "shell-out modules need an injectable runner for
  tests" - every side effect routes through this
  deps surface; production wires real helpers,
  tests wire stubs.
- `bin/fleetctl.ts` - one new `case 'onboard'`
  branch in the argv switch. Parses `--skip <list>`,
  `--non-interactive` / `--yes`, and `--help`. Per
  LESSONS 2026-05-29 "when a CLI subcommand adds
  boot output, take ownership of the listen
  banner" - the onboard branch owns its full
  stdout. Wires `runOnboard(productionDeps())` and
  exits with the appropriate code.
- `src/config.ts` - if the existing config writer
  is not a read-merge-write helper, add one (call
  it `updateConfigKey(key, value)`) so Step 4 can
  write the quiet-hours window without clobbering
  prior keys. PRODUCER-VS-SPEC NOTE: grep
  `src/config.ts` for the existing writer first
  (it may already exist under a name like
  `patchConfig` or `setConfigValue`).
- `tests/onboard.test.ts` (new) - one `test(...)`
  per AC checkbox. Uses the injected `deps`
  surface to drive the wizard with scripted stdin
  inputs. Per LESSONS § "time-pinned tests must
  NOT derive seed timestamps from `new Date()`",
  any time-sensitive assertions anchor to a
  pinned `now`. Per LESSONS § "in-process
  startServer() tests need an empty-roots config
  + run-row seeds", the subprocess test (AC11)
  plants a tmp `fleet-control.config.json` in cwd
  and restores on cleanup. Per LESSONS § "CLI
  subprocess tests need a FLEET_DB_PATH env
  seam", the subprocess test sets
  `FLEET_DB_PATH=<tmpdir>/fleet.db`.
- Schema migration: NO new tables. Composes
  existing `project`, `auth_token`, and
  `fleet-control.config.json` writers. Per
  LESSONS § "no backticks inside template-
  literal SQL strings", any SQL stays plain.
- No new runtime deps. The wizard is pure
  stdlib (`node:readline` for the line reader,
  `node:os` for the LAN IP if not already in
  the 0032 helper). Pairs with 0010 (register-
  url import path), 0021 (daily budget),
  0030 (quiet hours), 0032 (QR pairing),
  0024 (welcome checklist), 0003 (token mint),
  0016 (doctor liveness probe), and 0025
  (fleetctl demo precedent for "one-command,
  no-args, just-works" subcommands).

## Implementation log

### 2026-06-09 — in-progress (implementation-dev)

Composition-only wizard. New module `src/onboard.ts` exporting
`runOnboard(deps: OnboardDeps)` plus a `productionDeps()` wirer. New
`onboard` case added to `bin/fleetctl.ts`. Tests in
`tests/onboard.test.ts` — one `test(...)` per AC checkbox plus the AC11
CLI subprocess test that uses `FLEET_DB_PATH` + a planted tmp
`fleet-control.config.json` in cwd.

Producer-vs-spec reconciliation (per LESSONS 2026-06-05 "groomer prose can
disagree with the schema; the schema wins"):

- **Budget cap (0021)**: the spec calls for a "daily_budget_usd"-style
  column on `project`, but the actual producer (`src/control.ts`
  `set-budget` action + `src/budget_guard.ts` `parseCap`) reads
  `MAX_DAILY_USD` from the project's `agents.config.sh` manifest, parsed
  into `project.cadence_json.max_daily_usd`. There is NO column on
  `project` named `daily_budget_usd`. The wizard wires through
  `doAction(db, "local", "set-budget", { slug, max_daily_usd })` per
  project — the SAME helper the portal's per-project budget control
  invokes. No parallel storage.
- **Quiet hours (0030)**: the spec is right; the key under
  `fleet-control.config.json` is `quietHours: { start, end, tz }` (see
  `src/config.ts` + `src/quiet_hours.ts` consumers). The wizard does a
  read-merge-write so other config keys (`adminToken`, `projectRoots`,
  `ntfyTopic`, etc.) are preserved.
- **Token mint (0003)**: the wizard reads the existing token from
  `fleet-control.config.json`'s `adminToken` field if present (matches
  the welcome banner's resolver in `bin/fleetctl.ts` `serve` case). If
  absent, it mints a fresh admin-scoped token via `auth.mintToken(db,
  "onboard", "admin")` and writes it back to `fleet-control.config.json`
  so the next `serve` boot picks it up.
- **LAN + QR (0032)**: reuses `discoverLanUrl(host, port)` and
  `renderQrAscii(text)` directly. No parallel encoder.
- **Doctor liveness probe (0016)**: the wizard's `isServeRunning` check
  uses the same loopback HTTP probe `checkAdminSocket` uses — a `GET
  http://127.0.0.1:7070/api/health` via `node:http`. We don't import
  `checkAdminSocket` because it returns a `DoctorCheck` shape; the
  underlying primitive is a one-shot fetch and we just inline that
  shape into the deps surface.
- **Welcome checklist (0024)**: the spec asks for "checklist X/Y done"
  read via the same helper the 0024 banner uses. The 0024 banner
  enumerates 5 prescribed steps (open portal / loopback auth / add
  project / fleetctl doctor / live tail); it does NOT track per-step
  state. The wizard computes a derived count: step 3 ("add project") is
  "done" when at least one project is registered after the wizard's
  Step 1/2; the other 4 are always "available". So a fresh wizard run
  with at least one project registered prints "5/5"; a wizard with zero
  projects registered prints "4/5". This keeps the X/Y number
  meaningful without inventing a parallel `welcome_checklist` table.

Per LESSONS 2026-05-29 "when a CLI subcommand adds boot output, take
ownership of the listen banner": the onboard subcommand owns its full
stdout. The `startServeInBackground` helper does NOT inherit stdout from
the wizard — it daemonises via the same `installDaemon()` path (launchd
plist) so the wizard's stdout is the wizard's, end-of-story.

Per LESSONS § "shell-out modules need an injectable runner for tests":
every side effect routes through `OnboardDeps`. Production wires
`productionDeps()`; tests pass a stub object with scripted stdin reads
and recording stubs.

Per LESSONS § "in-process dedup sets need an explicit reset hook for
tests": `_resetOnboardForTests()` is exported; it clears the
module-level "have we run onboard in this process" flag the idempotency
AC needs.
