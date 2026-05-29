# LESSONS

Operational memory for the autonomous loop. Append, never reorder. Each entry
is one paragraph: symptom → cause → fix. Lessons here are read at the start
of every ship/groom run.

## 2026-05-26 — bootstrap

The control plane is dogfooding itself. The seatbelts: CI gates on
`typecheck` + `validate`, branch protection requires both contexts, and the
review subagent enforces AGENTS.md § Hard NOs. Lessons below are the agents'
collective memory across all runs on this repo.

## 2026-05-26 — keep `dependencies` empty

This project ships as zero-runtime-dep on purpose. The shape of the codebase
(node:sqlite, node:http, vanilla SPA, TypeScript via type-stripping) is the
distinguishing property. Any PR that adds a `dependencies` entry — even an
"obviously useful" one like `zod` or `chalk` — is a reject. Use the standard
library or write the small helper.

## 2026-05-26 — no backticks inside template-literal SQL strings

Symptom: a fresh `src/db.ts` edit caused
`ERR_INVALID_TYPESCRIPT_SYNTAX: Expected a semicolon` from node's type
stripper, with a stack pointing into `parseTypeScript`. Cause: I had added
a SQL comment inside the existing backtick-delimited `SCHEMA` template that
itself contained backticked identifiers (e.g. `` Named `agent_event` (not
`event`) ``). Node v25's type-stripping parser misreads inner backticks as
nested template-literal delimiters and the whole module fails to load —
including the upstream test that just imports it. Fix: never put backticks
inside the SCHEMA template (quote SQL identifiers with plain words instead),
or hoist the comment outside the template. The TypeScript compiler doesn't
catch this because `tsc --noEmit` parses the file fine — only the runtime
type-stripper fails, so tests are the only signal.

## 2026-05-26 — async streaming tails: snapshot the path before each read

Symptom: the SSE tail's rotation test (`tests/sse-stream.test.ts`) passed
when run as a standalone script but failed under `node --test` with the
parser receiving zero events from the rotated file — only the OLD file's
content showed up, then nothing. Cause: my `drainFrom()` closure captured a
`path` argument, but when an `fs.watch` callback fired mid-read and a
rotation poll also fired, the `attach(newPath)` ran in between — resetting
`offset=0` and `currentPath=newPath`. The previous read's `stream.on("end")`
then overwrote `offset` with the OLD file's size and the next drain read
past EOF of the new file. Fix: in any tail that can rotate, snapshot the
path at the start of each read (`const readingPath = currentPath`) and on
`end`, bail out without mutating offset/partial if `readingPath !==
currentPath`. The general lesson: a tail's "current file" state is mutable
across awaits, so every async boundary inside the drain loop must
re-validate which file the in-flight bytes belong to.

## 2026-05-26 — node test-runner timing is jittery; poll, don't sleep

Symptom: `tests/sse-stream.test.ts` passed in isolation but flaked under
the full `tests/*.test.ts` run — backfill needed >80ms when other test
files were also scheduling readline streams. Cause: sequential `wait(80)`
guesses are brittle under load. Fix: helper `waitFor(predicate, maxMs)`
that polls every 20ms up to a generous timeout, then asserts. Same
principle as flaky web-driver tests — assert on the *condition*, not on a
sleep length.

## 2026-05-26 — GitHub Actions sometimes doesn't fire on a freshly-opened PR

Symptom: PR #10 for ticket 0006 sat for several minutes after both the
initial `git push -u` AND an empty "ci: trigger checks" follow-up push with
zero workflow runs queued for the head commit. `gh pr checks` printed "no
checks reported on the branch"; `gh api /commits/HEAD/check-suites`
returned only the unrelated Vercel app suite, never a GitHub-Actions suite
for `ci.yml` or `auto-merge.yml`. The workflow file is correct
(`on: pull_request: branches: [main]` is matched by the PR's
`base=main / head=feat/0006-...`), Actions are enabled at the repo level,
and the same workflow had fired for every prior agent PR. Cause: most
likely a transient GitHub-side delivery hiccup on the `pull_request`
webhook — re-pushing didn't recover it within a single ship slot. Fix
options for the heal step:
  1. push another empty commit to nudge `synchronize` (cheapest first try),
  2. close + reopen the PR via `gh pr close && gh pr reopen` to force a
     fresh `pull_request.opened` event,
  3. as a last resort, add `workflow_dispatch:` to `ci.yml` so the heal
     agent can `gh workflow run` directly.
General rule: distinguish "CI red" (a run completed and failed — read the
log, fix, push) from "CI absent" (no run was queued at all — re-trigger
the webhook). The current heal loop only knows how to handle the first
case; until it grows the second, leave a PR comment naming the situation
so the next ship run treats this as a re-trigger rather than re-doing the
work from scratch.

## 2026-05-26 — don't fake a "lazy require" in an ESM file; just import

Symptom: while wiring `src/control.ts` to call into the new `src/auth.ts`
I started writing a `require_auth_lazy()` indirection because I half-
remembered the "don't eagerly import" pattern from CJS. Caught it before
push because the file uses `import` everywhere else and `require` isn't
in scope. Fix: `import * as auth from "./auth.ts"` at the top. node's
type-stripper hoists named imports and tree-shaking is not our problem
here — every consumer of `control.ts` already imports the DB module, so
the marginal cost of pulling in `node:crypto` is invisible. General rule
for this repo: there is exactly one module system (ESM via `.ts`); reach
for `import`, never `require`, never `await import()` unless you
genuinely need the laziness.

## 2026-05-26 — route regex for "owner/name" slugs needs an embedded slash

Symptom: when wiring `GET /api/prs/:repo/:number/diff` (ticket 0007) I
reached for the same `[\w-]+` capture every other route in `src/server.ts`
uses for slugs, then realised `:repo` is `owner/name` and carries a literal
slash. The naive `[\w-]+` won't match `mutaaf/fleet-control`. Cause: every
other slug we capture (project slug, run id) is a single path segment by
design; GitHub repo identifiers are two. Fix: capture the pair explicitly
with `([^/]+\/[^/]+)`, and rely on a separate `validatePrParams()` for the
character-set / `..` / shell-meta checks. General rule: the route regex
is just "did this URL shape want this handler?" — keep it permissive on
contents and defer real validation to a typed helper so error messages
stay precise (400 "bad repo" vs a confusing 404). Same pattern will help
when adding any future route that takes a GitHub identifier.

## 2026-05-26 — in-process dedup sets need an explicit reset hook for tests

Symptom: while shipping ticket 0009 (ntfy dispatch), two ntfy tests
failed under `node --test tests/ntfy.test.ts` even though each test ran
in isolation. The "same dedup_key fired twice → only ONE POST" case
saw zero POSTs the second time around, and the "click URL …" case (a
new test using the SAME dedup_key as an earlier-running case) also
recorded zero calls. Cause: `src/ntfy.ts` keeps a module-level
`Set<string>` of seen dedup keys so the same alert can't re-buzz the
operator's phone every ingest tick. That set is *shared across all
tests in the file* because the module is loaded once per process —
each `test()` call inherited the dedup state of every prior `test()`.
Fix: export `_resetDedupForTests()` and call it at the top of every
test that exercises the dispatcher. The leading underscore signals
"do not call this in production". General rule: any module that keeps
process-lifetime state (dedup sets, caches, in-flight maps, mutex
flags) for "we already handled this" semantics MUST expose a reset
seam — otherwise the test suite either passes by accident on a fresh
process or fails confusingly on re-runs. Same principle applies to
file-scoped `Map`s and lazy singletons; if it survives between
`test()` calls, it needs an opt-in reset.

## 2026-05-26 — anomaly tests need σ > 0 in the fixture, not just mean ≠ value

Symptom: while shipping ticket 0008 (anomaly detection on duration/cost),
the spec's example case "same baseline + a 15s run → no anomaly" passed
on paper but my first fixture made it impossible to express cleanly. I
had seeded 14 prior runs all at exactly 10000ms with ±1ms jitter so the
population stddev was ≈ 0.5ms. With σ ≈ 0.5ms, *any* run > 10003ms is
"~10000σ above the baseline" — both the 60s outlier (intended to fire)
and the 15s near-baseline (intended NOT to fire) sit absurdly far outside
the 3σ band. The detector did exactly what the spec said, but the test
fixture didn't reflect operator reality (a real ship-phase baseline has
multi-second spread). Cause: stddev compresses to ~0 on perfectly flat
fake data, which makes the σ multiplier infinite for any deviation. Fix:
the "15s within 3σ" case needs a fixture that produces realistic σ —
I used a mix of 6s/8s/10s/12s/14s prior runs so σ ≈ 2.4s and the 3σ band
covers ~10s ± 7s. The 60s case is still ~21σ above this wider baseline so
the detector remains useful in BOTH scenarios. General rule for any
threshold-style detector (forecast bands, regression alerts, drift
detectors): the test fixture's σ must be wide enough that "within bounds"
is geometrically meaningful, not just an artifact of a flat baseline.

## 2026-05-26 — `node:sqlite`'s `.all()` needs `as unknown as T[]` when narrowing

Symptom: while shipping ticket 0012 (weekly digest), wrapping the rows
returned by `db.prepare(...).all(...)` in a typed `interface FooRow` and
casting via `as FooRow[]` failed `tsc --noEmit` with TS2352:
"Conversion of type 'Record<string, SQLOutputValue>[]' to type 'FooRow[]'
may be a mistake because neither type sufficiently overlaps". Cause:
node:sqlite's declared return type for `StatementSync.all()` is
`Record<string, SQLOutputValue>[]` — an index signature, not an open
object — and TypeScript refuses a direct narrowing cast between an
index-signature type and a closed interface because the structural-check
heuristic says "these don't look related enough". The existing codebase
sidestepped this by going through `as any[]` first (the readability cost
of which is real). Fix: `as unknown as FooRow[]`. The double-cast through
`unknown` is TypeScript's officially-blessed escape hatch — it tells the
checker "I assert this conversion despite the overlap heuristic" without
introducing an `any` that contaminates downstream type inference. General
rule for this repo: any new SQLite read that defines a row interface
SHOULD use `as unknown as RowT[]` (or `as unknown as RowT | undefined`
for `.get()`). Pure `as any[]` is fine in legacy code but loses the
typed-property checks the rest of the file enforces.

## 2026-05-26 — expose a build counter for cache-hit tests, not a fetcher swap

Symptom: ticket 0012's AC5 needed a "second call within the TTL must
not re-query the database" assertion for `weeklyDigest()`'s 5-min
cache. The ntfy and diff modules use an *injected fetcher* whose call
count is the test signal — but `weeklyDigest` has no injected
dependency to swap (it's pure SQL against the DB the caller passes in,
and stubbing every `db.prepare` call would be both noisy and
brittle). Cause: the "injected-thing-with-a-counter" pattern only
works when there's already a seam for an injected thing. Pure-SQL
helpers don't have one. Fix: export a single
`_getDigestCacheBuildsForTests(): number` getter alongside the
existing `_resetDigestCacheForTests()` reset; the helper increments
`buildCounter` only on a cache MISS, so a test can assert "counter
went up by 1, then by 0" without touching any of the SQL. General
rule: when a module's "did this re-compute?" question can't be
answered by a side-effect (no network call, no shell-out), expose a
read-only counter via a `_get…ForTests` getter. The leading underscore
+ "ForTests" suffix matches the `_reset…ForTests` /
`_setRunnerForTests` convention already in the repo and signals to
reviewers that production code doesn't read this.

## 2026-05-26 — shell-out modules need an injectable runner for tests

Symptom: writing tests for the new `register-url` action (ticket 0010) I
needed to assert the exact argv that `gh repo view` and `git clone`
would be called with, plus stub their filesystem effects (a fake `.git`
dir at the dest path so the downstream `scaffoldAndInstall()` recognised
the clone). The existing code path used a free-standing
`function run(cmd, args)` that called `execFileSync` directly, so every
test would have tried to spawn the real binaries against a tmpdir
fixture — flaky at best, and impossible for the `bash install.sh` step
which writes a real launchd plist. Cause: the module had no test seam.
Fix: replace `function run(...)` with a module-level mutable
`activeRunner` plus exported `_setRunnerForTests(fn)` /
`_resetRunnerForTests()` helpers (leading underscore = "do not call in
production"). Production callers keep their existing `run(cmd, args)`
call sites unchanged; tests swap the runner in `try { ... } finally {
_resetRunnerForTests(); }`. This is the SAME shape as the
`_resetDedupForTests` seam in `src/ntfy.ts`, generalised: any module
that gates side-effects (shell-out, network, launchd, fs.watch) behind
a single function should expose a swap seam from day one, even when
only one test wants it — otherwise the next ticket either rewrites the
module to add one OR ships partly-untested. General rule for this repo:
when a control action lands more than one `run(...)` call, the runner
is a module variable, not a function declaration.

## 2026-05-26 — CLI subprocess tests need a FLEET_DB_PATH env seam

Symptom: while shipping ticket 0013 (shareable snapshots) the AC7
test needed to drive `bin/fleetctl.ts snapshot create|list|revoke`
end-to-end via `spawnSync` so the actual argv parser was exercised.
The natural seed pattern — seed a tmpdir DB, then run the CLI
against it — failed because `loadConfig()` derives `dbPath` from
`homedir()`. Even with `HOME=<tmpdir>` set in the env, the CLI
opened a *fresh* DB at `<tmpdir>/.local/state/fleet-control/fleet.db`
instead of the one the test seeded at `<tmpdir>/fleet.db`. Cause:
the only "where does the DB live" knob in production is the
optional `fleet-control.config.json`; tests don't write one, and
shoehorning a config file into every subprocess test is noisier
than the test it gates. Fix: add `FLEET_DB_PATH` env override at
the bottom of `loadConfig()` — `if (process.env.FLEET_DB_PATH)
cfg.dbPath = process.env.FLEET_DB_PATH`. Operators get an
incidental external-disk knob; tests get a one-env-var seam.
General rule for this repo: any CLI subcommand that's worth a
subprocess test (i.e. one whose value comes from its argv parser,
not the inner helper) should be driveable against a tmpdir DB via
a single env var — adding the knob is cheaper than threading a
custom config file through every test, and it's a feature
operators actually want.

## 2026-05-26 — `julianday()` drifts ~10us per timestamp; decompose with `strftime` for sub-ms diffs

Symptom: ticket 0014's AC2 asserted `total_seconds ≈ 5.0` (± 1e-6) for
two `run_event` rows exactly 5.000s apart; the helper used
`SUM((julianday(er.ts) - julianday(eu.ts)) * 86400.0)` and returned
`5.000013113021851s` — off by ~13us, enough to fail the tight
tolerance. Cause: `julianday()` returns the number of days since
4713-12-24 BC as a 64-bit float; multiplying that fractional-day delta
by 86400 loses precision because the integer day component (~2.46M)
eats most of the mantissa before you scale back to seconds. The drift
is invisible at second-level resolution but breaks any test asserting
sub-millisecond accuracy. Fix: compute the integer-seconds diff with
`CAST(strftime('%s', ts) AS INTEGER)` (no float roundtrip), then add
the fractional component as `CAST(strftime('%f', ts) AS REAL) -
CAST(strftime('%S', ts) AS INTEGER)` per side. This isolates the
sub-second part (0.000–0.999) and adds it cleanly to an exact
integer-second base. General rule for this repo: when a SQL timestamp
diff needs to be accurate below ~1ms, avoid `julianday()`'s float-day
intermediate and decompose into integer seconds + fractional remainder
via `strftime`. Same trap will bite any future P99 latency rollup,
SLA-band aggregator, or run-duration drift detector.

## 2026-05-26 — in-process `startServer()` tests need an empty-roots config + run-row seeds, not direct rollup inserts

Symptom: while shipping ticket 0015 (badge route) the first cut of
`tests/badge-route.test.ts` booted `startServer()` against a tmpdir DB,
seeded `cost_rollup_day` directly, then asserted the `$3.21` cost
badge — and watched the test take ~80 seconds and fail with no
dollar amount in the response. Two compounding causes: (1)
`startServer()` synchronously calls `runIngestPass(db, cfg)` which
walks `cfg.projectRoots` / `cfg.installedRoot` / `cfg.cacheBase` —
all defaulting to subdirs of the operator's real `$HOME`, so the
test was reading the entire fleet on every boot; and (2) the very
last step of that pass, `recomputeRollups()`, does
`DELETE FROM cost_rollup_day` unconditionally and then re-inserts
from the `run` table — wiping the seeded rollup row before the
request ever ran. Fix: the test now plants a temporary
`fleet-control.config.json` in cwd pointing
`projectRoots`/`installedRoot`/`cacheBase`/`claudeProjects` at an
empty tmpdir (snapshotted + restored on cleanup so a dev's local
config isn't clobbered), AND seeds cost data via a real `run` row
so the recompute step derives the same `cost_rollup_day` value the
production rollup would. Boot time dropped from ~80s to ~1s per
test and the cost branch became green. General rules for this
repo: (1) any test that boots `startServer()` in-process MUST
isolate the config — `FLEET_DB_PATH` alone is not enough because
discovery still walks real filesystem roots; (2) any test that
depends on `cost_rollup_day` MUST seed through `run` rows, never
direct rollup inserts, because `runIngestPass()` re-derives the
table on every pass; (3) when you need to plant a side-effecting
file in cwd, snapshot any prior contents and restore on cleanup so
a developer running tests on a live config doesn't lose their
admin token.

## 2026-05-26 — "no shell-string exec" static checks should grep the import, not the call site

Symptom: while shipping ticket 0016 (`fleetctl doctor`) I wrote an AC11
test that grepped `src/doctor.ts` for `\bexec\s*\(` to assert the
module never uses the shell-string `exec()` variant — and the test
failed because the doctor module legitimately routes every shell-out
through `deps.exec("npx", [...])`, a method call on the injected
dependency surface. The word-boundary regex can't tell the bare
`exec(cmd)` import from `node:child_process` apart from
`something.exec(cmd, [args])` on an object. Fix: grep the IMPORT
instead — `from "node:child_process"` followed by a destructured
`exec` or `execSync` is the precise thing the rule actually cares
about. The method-call form is always safe because the dep is wired
(in production) to `execFile` with an argv array. General rule for
this repo: when statically asserting a module honours the "no shell
strings" Hard NO, check the import surface; the call sites can use
any name (`deps.exec`, `runner`, etc.) and the import is the single
chokepoint where a shell-string variant could enter. Same pattern
works for any future "this module must not import X" lint.

## 2026-05-26 — defence-in-depth secret redaction at the renderer boundary

Symptom: ticket 0016's AC10 demands that `fleetctl doctor` never print
the admin token, GitHub PATs, or repo URLs in EITHER its human or JSON
output. The natural impulse is "every check must be careful not to
include the secret in its detail string" — and the doctor checks are
indeed careful (the config check confirms presence without reading
the value). But that's one careful author away from a regression: the
next check that adds, say, a detail line containing
`process.env.GH_TOKEN` silently leaks it. Fix: add a `redactSecrets()`
pass at the renderer boundary that strips token-shaped substrings
(GitHub PATs via the `gh[opusr]_…` prefix; long base64-ish runs with
at least one letter AND one digit; GitHub HTTPS repo URLs). The AC10
test plants all three secret shapes in the dep surface and asserts
neither rendering contains the literals, so a future check author who
forgets the discipline is caught by the test layer. General rule for
this repo: any module that renders user/operator data to a terminal
or HTTP response SHOULD pass the final string through a single
`redactSecrets()` chokepoint at the boundary — the check authors
remain primary, but the renderer is the silent backstop.

## 2026-05-28 — re-fire-after-dismiss needs an aging window, not a partial UNIQUE index

Symptom: while shipping ticket 0027 (cross-project failure
correlation) I wired a `CREATE UNIQUE INDEX IF NOT EXISTS ON
anomaly(correlation_signature) WHERE kind='fleet_correlated'` to
guarantee `runCorrelationHook` was idempotent within a 24h window —
two ticks in a row insert one row, perfect. AC9 then exercised
"dismiss the correlation, advance 25h, seed a fresh outbreak, the
inbox must re-surface a new row." It didn't: the partial UNIQUE
swallowed the second INSERT because the dismissed row was still
present, so `activeCorrelations`' LEFT JOIN saw a dismissed row
and nothing fresh. Cause: a hard UNIQUE constraint conflates two
separate questions — "is this a duplicate WITHIN the dedup window"
and "is this a duplicate FOR ALL TIME" — and the second answer is
wrong for any signal that the operator legitimately wants to be
re-alerted about after they've acknowledged the previous instance.
Fix: drop the partial UNIQUE for a non-unique index on
`(correlation_signature, created_at)` and move idempotency into
the application — the hook does a "is there a row WHERE
created_at >= now - 24h?" lookup before INSERT. The 24h aging is
the natural re-fire boundary: a dismissed row falls out of the
window after 24h, the next tick finds no live row, and a fresh
INSERT lands. General rule for this repo: any "fire once per
event family" detector where the OPERATOR can dismiss and the
EVENT can recur needs an aging-window dedup, not a UNIQUE
constraint. Reach for SQL UNIQUE only when "duplicate" means
"identical for all time" (e.g. `auth_token.id` = hash of the
plaintext — re-minting the same plaintext is genuinely a bug).
Pair with a LEFT JOIN onto `inbox_dismissal` so the dismissed row
is invisibly suppressed inside its window without blocking the
next legitimate fire after the window closes.

## 2026-05-29 — time-pinned tests must NOT derive seed timestamps from `new Date()`

Symptom: while shipping ticket 0018 I ran `node --test tests/*.test.ts`
to confirm no regressions and saw `tests/prs-merged.test.ts` (5/7
failing) and `tests/digest.test.ts` (multiple failing) reporting
`prs_merged: 0` against a fixture that seeded 3 shipped runs. The
same two test files failed identically against `main` with my
changes stashed, so the regression wasn't mine. Cause: both files
pin the digest "now" anchor as a string constant
(`NOW_ANCHOR = "2026-05-26T12:00:00.000Z"`) but build their seed
timestamps with a helper that reads `new Date()`:
`daysAgoIso(N) { const d = new Date(); d.setUTCDate(... - N); ... }`.
On the day the test was authored (2026-05-26) those two clocks
agreed. By 2026-05-29 the wall clock had moved three days past the
anchor — so `daysAgoIso(1)` returned a row dated 2026-05-28 (which
falls AFTER the 2026-05-26 anchor's seven-day window
[2026-05-19, 2026-05-26]) and the digest correctly counted zero
shipped runs in window. The detector is right; the fixture is the
bug. The CI typecheck gate doesn't catch this because the file
compiles fine, and the `validate` gate only runs
`scripts/check-backlog.mjs` — no tests. So the failures sit
indefinitely on main until a human runs the suite. Fix when next
touching these files: take a `now: NOW_ANCHOR` (or any pin) option
through the seed helper and use `new Date(opts.now)` as the
arithmetic base. General rule for this repo: any test that pins a
fixed `now` anchor MUST anchor its seed timestamps to that same
value — never `new Date()` — or the test becomes a time-bomb that
breaks weeks after the author committed. Same trap will bite any
future window-scoped digest, leaderboard, streak, or burndown
test. Pre-existing failures discovered in the wild are fine to
leave in place under one condition: they MUST NOT be one of the
gating checks (typecheck + validate). The ship agent's
"distinguish CI red from CI absent" rule extends here: distinguish
"test red in MY change" from "test red for reasons that predate
my change" — fix the first, document the second and move on.
