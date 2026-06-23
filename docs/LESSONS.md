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

## 2026-05-29 — when a CLI subcommand adds boot output, take ownership of the listen banner

Symptom: while shipping ticket 0024 (first-run welcome printed by
`fleetctl serve`) my first cut wired `firstRun()` into the existing
`startServer({ onListening })` hook without setting `quietBanner: true`
— so a cold-start run printed `fleet-control portal → http://127.0.0.1:7070`
FIRST (from inside `server.listen`'s default callback) and the
12-line welcome AFTERWARDS. Subsequent runs printed the legacy banner
PLUS my new one-line `fleet-control serving on ...` quiet form — two
lines saying the same thing, in opposite styles. Cause: `startServer`'s
listen callback is a multiplexer — it prints its own line by default
AND invokes the caller's `onListening`. Any CLI subcommand that wants
to own boot output must opt out of the default banner explicitly via
`quietBanner: true` (the same flag the demo subcommand from ticket
0025 already uses for the same reason). Fix: set `quietBanner: true`
in the serve case and have the CLI re-emit the legacy `fleet-control
portal → ...` line ITSELF when `--no-welcome` is passed (so existing
scrapers and operator muscle memory still see exactly one banner).
General rule for this repo: any new CLI subcommand that intends to
emit a boot banner MUST pass `quietBanner: true` to `startServer` and
own the full boot stdout — otherwise the operator gets two banners
that race the kernel's listen callback in unpredictable order. Same
trap will bite future subcommands (`fleetctl serve --json-logs`,
`fleetctl serve --quiet`, etc.) that want to control startup output.

## 2026-06-05 — break ingest↔server cache-invalidation cycles via a globalThis slot, not a circular import

Symptom: while shipping ticket 0039 (fleet changelog page) I needed
the 60s changelog memo cache (defined in `src/server.ts`) to be
invalidated the moment `runIngestPass()` (in `src/ingest/index.ts`)
commits a tick — so a freshly-merged PR surfaces on the next
render instead of waiting out the TTL. The first instinct was the
direct route: `import { _invalidateChangelogCacheAfterIngest } from
"../server.ts"` inside `runIngestPass`. That immediately deadlocks
node's ESM cycle detector — `src/server.ts` already
`import { runIngestPass } from "./ingest/index.ts"` at the top, so a
return-trip import would create a cycle whose evaluation order is
runtime-undefined (one side sees `undefined` for the symbol it
needs). Cause: the cache lives on the consumer side (server) but
the invalidation trigger lives on the producer side (ingest);
making either side import the other creates a cycle the moment they
both load at boot. Fix: register the invalidation function on
`globalThis` from `src/server.ts` on module load
(`(globalThis as { __fleet_changelog_invalidate__?: () => void })
.__fleet_changelog_invalidate__ = _invalidateChangelogCacheAfterIngest`),
and have `runIngestPass` read it lazily off `globalThis` after the
COMMIT — typed `as { __fleet_changelog_invalidate__?: () => void }`
so tsc still type-checks the call. The hook is a no-op when the
server module hasn't loaded (e.g. the launchd daemon imports the
ingest module but not the server), which is exactly the right
behaviour: no server, no cache, no invalidation needed. General
rule for this repo: when module A owns a cache that module B's
side-effect must invalidate AND B is already imported by A, do NOT
introduce a B→A import — register the invalidation function on a
documented `globalThis.__fleet_<feature>_<verb>__` slot from A's
load-time and have B late-bind via the slot. The leading-and-
trailing-double-underscore convention signals "do not collide" the
same way `_resetXForTests` signals "do not call in production."
Same trap will bite any future feature where an ingest tick (or
any "the world changed" trigger that fires from a producer module
the server already depends on) needs to wake a consumer-side memo.

## 2026-06-05 — groomer prose can disagree with the schema; the schema wins

Symptom: ticket 0040 (riskiest open PR badge) specified the helper's
main query as `SELECT FROM pr WHERE state = 'OPEN' AND is_agent = 1`
in upper-case prose. The first cut of `riskiestOpenPr()` followed the
prose verbatim and returned `open_count: 0` against every fixture
that seeded `state: 'open'` — because the production ingester
(`src/ingest/prs.ts` line 164) writes the literal string `'open'`
(lower-case) on every pass, and SQLite's `=` is case-sensitive on
TEXT comparisons by default (no `COLLATE NOCASE`). The helper's tests
failed instantly; tsc was clean (a string literal compares to any
string at the type level); the validator was clean (no schema change
needed). Only the run-the-tests step caught it. Cause: the groomer's
spec text was written without round-tripping through the actual schema
— it described the INTENT (open PRs only) using one casing, while the
ingester historically picked another. Fix: query `state = 'open'` and
document the reconciliation in the Implementation log. General rule
for this repo: when a ticket's engineering notes name a column value
literally (state, ci_state, outcome, kind, phase), `grep` the
ingester / writer paths in `src/ingest/*.ts` for that exact column
before writing the SELECT — the source of truth is the producer, not
the spec. Same family as the courtiq cross-fleet lesson
"groomer billing-shorthand vs schema": the spec is a hint, the
schema is the contract. `cost_rollup_day.phase`, `run.outcome`,
`pr.ci_state` (`'red' | 'pending' | 'green' | 'none'` — NOT the
GitHub-rollup tokens FAILURE/SUCCESS/PENDING the spec used), and
`anomaly.kind` are all places this trap could bite next; the producer
file is the chokepoint to grep.

## 2026-06-07 — the `pr` table has no surrogate `id`; proxy "latest landed" via (MAX(fetched_at), COUNT(*))

Symptom: while wiring ticket 0044's spend-efficiency cache I copied
the 0040 riskiest-PR invalidation-tuple pattern (`SELECT MAX(id)
FROM pr WHERE state='MERGED'`) and got an instant runtime 500 against
the booted test server: `no such column: id`. Cause: the `pr` table
in `src/db.ts` declares `PRIMARY KEY(project_id, number)` and NO
`id INTEGER PRIMARY KEY` autoincrement column — unlike `run`,
`anomaly`, `control_audit`, and most other tables in this DB. The
spec's "latest_merged_pr_id" is a column that doesn't exist. The
fix is to proxy "fresh merge landed" with a TWO-VALUE pair:
`MAX(fetched_at)` (catches the case where the same row's sync
timestamp advances) AND `COUNT(*)` (catches a new row inserted that
happens to share the same fetched_at). Either moving busts the
cache identically to a phantom id. General rule for this repo: any
new cache that wants to invalidate on "fresh `pr` row landed" MUST
use the `(MAX(fetched_at), COUNT(*))` pair, never `MAX(id)`. The
groomer's spec text routinely names a `latest_<table>_id` tuple
component without confirming the column exists; round-trip every
such reference through the schema in `src/db.ts` before writing
the SELECT. Adjacent tables with the same composite-PK shape and
no surrogate id today: `cost_rollup_day` (PK `(project_id, phase,
day)`), `project_alias` (PK `alias_slug`), `pricing` (PK `model`),
`watermark` (PK `source`), `inbox_dismissal` (PK `(kind,
project_slug, payload_id)`), `home_last_seen` — same trap applies
to any future cache keyed off "the latest row in any of these."

## 2026-06-10 — when an ingester grows a second shell-out, legacy stubs that don't discriminate on argv silently collide

Symptom: while shipping ticket 0049 I extended
`src/ingest/prs.ts` to fire `gh pr list --state closed` alongside
the existing `--state open` call. The new tests in
`tests/prs-ingest-closed.test.ts` passed instantly, but three
legacy test files (`tests/prs-ingest.test.ts`,
`tests/correlate.test.ts`, `tests/health.test.ts`) started
failing with `UNIQUE constraint failed: pr.project_id, pr.number`.
Each of those legacy stubs is shaped
`_setPrRunnerForTests((cmd, args) => { if (cmd === "gh" &&
args[0] === "pr" && args[1] === "list") return JSON.stringify([
{ number: 42, ... } ]); return ""; })` — it returned the SAME
PR payload for ANY `gh pr list` invocation regardless of argv.
Pre-0049 that was fine because the ingester only called gh once
per pass. Post-0049 the same row tried to land twice (once
through the open INSERT, once through the closed INSERT) and
hit the composite PK. Cause: the test stubs simulated gh's
behaviour at a coarser granularity than the production
ingester's call surface — the stubs ignored the very flag
(`--state`) that real gh uses to differentiate which rows it
returns. Fix: tighten each affected stub to inspect
`args.indexOf("--state")` and return `[]` for the non-target
state (a refinement, not a weakening — real gh never returns
the same PR row for both `--state open` AND `--state closed`).
General rule for this repo: when adding a SECOND shell-out
through an existing runner seam (`_setRunnerForTests`,
`_setPrRunnerForTests`, etc.), audit every test that uses the
seam — any stub that returns a non-empty payload for "any
matching command" is a latent PK / dedup-key collision the
moment the new shell-out reuses the same gh subcommand with
different flags. The fix is always in the stub: discriminate
on the same axis the real CLI does (`--state`, `--repo`,
`--branch`, `--json` field projection, etc.). Same trap will
bite any future ingester that grows from one→N shell-outs
against the same `gh` / `launchctl` / `git` subcommand. The
production side has an idempotency option (UPSERT or per-row
dedup map) but that hides the test-stub gap; tightening the
stub is the cleaner signal.

## 2026-06-10 — `redactSecrets` on a JSON body shreds your KEYS, not just your values

Symptom: while shipping ticket 0052 I wired the new
`/api/fleet/lessons/savings` JSON route to defence-in-depth-
scrub token-shape substrings before `res.end`, copy-pasting the
existing `redactSecrets()` regex from `src/receipts.ts` /
`src/doctor.ts`. The first test against an empty fleet asserted
`average_failed_ship_cost_usd` (the documented top-level
number) and got back `undefined` — the field name was missing
from the JSON entirely. Cause: the `redactSecrets` regex
`\b[A-Za-z0-9_]{24,}\b` with the `hasDigit = /\d/.test(match)
|| /_/.test(match)` heuristic treats UNDERSCORE as a digit-
qualifier. That's the right call when scanning narrative TEXT
(a token like `gh_abcdef…` has letters and may have underscores
but no digits — the underscore stand-in is what gates the
classifier). It's the WRONG call when the input is a JSON body:
my own top-level keys (`average_failed_ship_cost_usd` is 27
chars, letters-and-underscores ONLY) match the
`[A-Za-z0-9_]{24,}` shape AND the `hasLetter && hasDigit` gate
(because `_` is "digit"). So `JSON.parse(redactSecrets(JSON.
stringify(rollup)))` mangled my schema — the JSON parser saw
`"<redacted>"` where the key name used to be, and the test's
`typeof j.average_failed_ship_cost_usd === "number"` assertion
hit `undefined`. Fix: route the redactor through the rollup's
operator-supplied STRING VALUES (lesson_slug, lesson_date,
lesson_title) BEFORE the rollup is `JSON.stringify`'d, not over
the JSON body string. The values are the surface that can
carry an upstream-tail-leaked token; the keys are repo-authored
and structurally safe. I also tightened the regex's digit gate
(`hasDigit = /\d/.test(match)` — no longer treating `_` as a
digit-qualifier) for this redactor specifically; a real
token-shape substring always carries at least one numeric
digit. General rule for this repo: when a defence-in-depth
redactor moves from text/HTML routes to a JSON route, scrub
the values, NOT the body string. The token-shape heuristic is
LATENT-ambiguous between "long underscore-separated identifier"
(safe — your JSON key) and "long underscore-laden secret"
(unsafe — your leaked token), and the only side that always
gets the right answer is the value side. Same trap will bite
any future JSON route that copy-pastes `redactSecrets` from a
text renderer — the symptom is silent JSON shape mangling
(your field names get replaced by `<redacted>`), which the
typecheck CAN'T catch (it's a runtime string op over a
serialised body) and which tests catch only if they assert
shape, not just status code.

## 2026-06-11 — startServer() tests that mutate `fleet-control.config.json` race against parallel test files; expose a renderer-direct seam for branch tests

Symptom: while shipping ticket 0054 I wrote an AC7 quiet-hours
test that booted `startServer()` against a tmp DB and planted a
`{ quietHours: { start: "00:01", end: "00:00", tz: "UTC" } }` config
in cwd to drive the CTA-suppression branch. The test passed when
run in isolation (`node --test tests/pulse.test.ts`) and passed
again under `--test-concurrency=1`, but failed the moment another
test file (e.g. `tests/receipts.test.ts` or
`tests/year-in-review.test.ts`) ran concurrently: my `boot()`
helper wrote the quietHours config, a parallel test file's
`boot()` (in its own subprocess) wrote a DIFFERENT config to the
SAME `fleet-control.config.json`, and `startServer`'s
`loadConfig()` then read whichever write landed last — the CTA
either appeared (quietHours dropped on the floor) or the page
404'd (someone else's malformed config). Cause: `process.cwd()`
is shared across all node:test subprocesses on the same machine;
the `savedConfigText` snapshot in the test's `boot()` helper is
per-process; the FILE is global. Each subprocess thinks IT owns
the config; the filesystem disagrees. The receipts/year/lesson-
savings tests don't see this because none of them mutate
quietHours — they all write the same empty-roots shape, so a race
between two identical writes is invisible. The first test to
mutate a NON-DEFAULT config key (quietHours, projectRoots
overrides, etc.) is the one that exposes the race. Fix: for any
test that needs to drive a BRANCH that depends on configuration,
export a renderer-level test seam (e.g.
`_renderPulsePageForTests(payload, { quietHoursActive: true })`)
so the test can hand-roll the input the renderer would have
received from `quietHoursActiveAnywhere(cfg, now)` — zero cwd
mutation, zero HTTP, zero race. The boot-path tests stay valuable
for the integration shape (route exists, content-type, cache-
control, testids present) but the cfg-dependent BRANCHES belong
in renderer-direct unit tests. General rule for this repo: any
new test that needs to write a NON-DEFAULT field to
`fleet-control.config.json` is a smell — extract the renderer
function, export a `_render*ForTests` seam, and drive the branch
directly. The boot-path test is for "the route is wired"; the
renderer-direct test is for "this input produces this output."
Same trap will bite any future ticket that needs to drive an
auth-gated, quietHours-gated, or per-project-override-gated
branch through a startServer() boot — `--test-concurrency=1`
"fixes" the symptom but doesn't fix the architecture.

## 2026-06-11 — character-window source greps leak into sibling helpers; backticked identifiers in adjacent comments break the slice

Symptom: while shipping ticket 0056 I added a new sibling helper
`lessonSavingsByProject` immediately after `lessonSavingsRollup`
in `src/views.ts`. The new helper's leading comment block
referenced existing identifiers like `` `lessonSavingsRollup` ``,
`` `'failure'` ``, and `` `heal_count` `` — backticked because
that's the standard markdown-in-comment convention this codebase
uses for inline code. My ticket's typecheck + my new test suite
were both green, but the existing 0052 AC10 grep test
(`tests/lesson-savings.test.ts:783`) — which asserts
"`lessonSavingsRollup` must not embed SQL keywords inside a
backtick template literal" — started failing. Cause: the 0052
test computes `const idx = VIEWS_TS.indexOf("lessonSavingsRollup")`
then slices `VIEWS_TS.slice(idx, idx + 4000)` and regex-greps for
`` /`[\s\S]*?(SELECT|FROM|WHERE|GROUP BY|ORDER BY)[\s\S]*?`/i ``.
That slice doesn't end at the closing brace of
`lessonSavingsRollup`; it just walks 4000 characters forward.
When I inserted the new helper right after, the slice now
contained: (a) the first backtick from a comment INSIDE
`lessonSavingsRollup` (`` `pr` table ``), (b) the actual SQL
string-concatenation inside `lessonSavingsRollup` (full of
SELECT/FROM/WHERE), and (c) a second backtick from MY new
comment block (`` `lessonSavingsRollup` `` as a cross-reference).
The non-greedy `[\s\S]*?` happily stretched from (a) to (c),
matching all the SQL keywords in between — even though no SQL
keyword was ever inside a backtick template literal. The regex
is correct in shape (any backtick-to-backtick run that contains
a SQL keyword IS suspicious) but the character-window slice is
too greedy when there's a sibling helper next door. Fix: drop
the backticked identifiers from the new helper's comment block
— plain prose like `lessonSavingsRollup` (no backticks) reads
identically and stops the regex from matching across helpers.
The 0052 test stays untouched (it's still the correct guard for
the helper it names); the new helper just doesn't carry the
backtick-comment style that overlaps the slice window. General
rule for this repo: when a test does
`VIEWS_TS.slice(indexOf(name), indexOf(name) + N)` to scope a
grep to "this helper", any future sibling inserted within `N`
chars inherits the test's regex constraints. The safer slicing
pattern is `VIEWS_TS.slice(indexOf(name),
VIEWS_TS.indexOf("\n}\n", indexOf(name)))` (walk to the closing
brace at column 0) — but retrofitting that across every existing
guard is more churn than just keeping new comment blocks free of
backticked SQL-adjacent identifiers. Pre-flight check for any
ticket that adds a sibling helper next to an existing one: grep
the test suite for that helper's name + ".slice(" or ".indexOf("
and confirm the new sibling's comment block won't poison the
window. Same trap will bite any future ticket that adds a helper
adjacent to one with a character-window source grep
(views.ts has several: lessonSavingsRollup, lessonCreditRollup,
fleetWeeklyPulse, etc.).

## 2026-06-12 — greedy `[^>]+id=` regex over a `<h2 id="..." data-testid="...">` captures the wrong attribute

Symptom: while shipping ticket 0057 (public lesson archive) the AC4
permalink test pulled a slug out of the rendered index HTML via
`body.match(/<h2[^>]+id=["']([a-z0-9-]+)["']/)`, then hit
`GET /lessons-public/<slug>` and got an unexpected 404 against a
server that DEFINITELY had the lesson in its archive. Cause: the
rendered tag was `<h2 id="redactsecrets-on-..." data-testid=
"lesson-public-redactsecrets-on-...">` — and the greedy `[^>]+`
inside the regex slurped right through the `id="..."` attribute
all the way to `data-testid=` (which ends with `testid=`, which
contains the literal `id=`), capturing `lesson-public-<slug>`
instead of the plain `<slug>`. The lookup against the archive's
`lesson_slug` field then 404'd because no row carries the
`lesson-public-` prefix. Fix: anchor the parse on the testid
itself (`/data-testid=["']lesson-public-([a-z0-9-]+)["']/`) — the
suffix on the testid IS the slug by construction, and the testid
attribute is unambiguous (no other attribute matches it). General
rule for this repo: when a test wants to scrape an attribute out
of an HTML element via regex, NEVER use `[^>]+attr=` with a
greedy quantifier when ANOTHER attribute on the same tag ends in
the literal `attr=` substring (`data-testid` collides with any
greedy `id=` regex; `aria-labelledby` collides with `by=`; etc.).
Anchor on the most-distinctive attribute name, OR use a non-
greedy quantifier `[^>]*?` followed by a word-boundary before the
`attr=` token. The renderer was correct; the test's regex was the
bug. Same trap will bite any future test that scrapes a slug /
id / name out of a rendered HTML element that ALSO carries a
testid suffixed with that same value (a common pattern in this
codebase: `<a id="<slug>" data-testid="<prefix>-<slug>">`).

## 2026-06-13 — function-import cycles aren't always cache-invalidation; sometimes the cheapest fix is a 6-line inline copy of the helper

Symptom: while shipping ticket 0058 (public failure-mode landing pages)
I wanted the new `fleetFailureModes()` helper in `src/views.ts` to
share the 0057 anonymisation pass (`anonymiseLessonBody` in
`src/lessons.ts`) so operator slugs / `/Users/` paths / agent branches
collapse to the same placeholders across both public surfaces. The
natural move was to export `anonymiseLessonBody` from `src/lessons.ts`
and add `import { anonymiseLessonBody } from "./lessons.ts"` to
`src/views.ts`. The typecheck passed. The first test run failed at
module load: `src/lessons.ts` already does `import { lessonSavingsRollup
} from "./views.ts"` (added in ticket 0055), so my new edge created a
two-way function-import cycle. Node's ESM cycle detector doesn't crash
on it but evaluation order is runtime-undefined — one side may see
`undefined` for the imported symbol depending on which module the
entrypoint loads first. Cause: the 2026-06-05 globalThis-slot lesson
covers ONE specific shape of cycle (a server-side cache that an
ingest-side producer must invalidate); it does NOT cover a vanilla
two-module function dependency where neither side owns a runtime
cache. Reaching for the globalThis-slot pattern here would be silly —
the function is pure, no state, no producer/consumer asymmetry. Fix:
inline the helper as a private `anonymiseExcerpt` inside `views.ts`
(6 lines + one local `reEscape`). The two copies will drift the day
someone adds a fifth anonymisation rule; that's still cheaper than the
audit cost of a function-import cycle that bites at the next
`import { somethingElse } from "./views.ts"` inside `lessons.ts`.
General rule for this repo: BEFORE adding a `from "./views.ts"` import
to ANY module that `views.ts` already imports (today: `lessons.ts`,
`config.ts`, `correlate.ts`, `quiet_hours.ts`, `inbox.ts`, `digest.ts`,
`live.ts`, `alerts.ts`, `daemon.ts`, `drift.ts`, `anomaly.ts`,
`ingest/prs.ts`), grep for the OTHER direction with
`grep -n "from \"\\./views" src/<other>.ts`. If both sides need a
helper that's stateless and short, prefer a private inline copy in
each side OR hoist the helper to a tiny third module (e.g.
`src/anonymise.ts`) that neither side already imports. The globalThis-
slot pattern stays in its lane: it's the right answer ONLY when one
side owns a cache the other side's COMMIT must invalidate. A pure
function dependency is not that shape.

## 2026-06-13 — per-candidate detection fixtures must also satisfy the global empty-fleet gate

Symptom: while shipping ticket 0059 (biggest surprise this week)
the AC2/AC5/AC6 candidate-detection tests all failed on first
run with `kind:'none'` and the warming-up sentence — even though
each fixture seeded the documented per-candidate minimum (4
weeks for silent-project, 5 prior merges for heal-streak, 5
trailing-90d PRs for new-author-red). The helper was correct;
each candidate's local threshold was met. But the helper ALSO
enforced a GLOBAL "fleet has < N weeks of pr data → warming
up" empty-state gate (the documented AC10 honest empty state)
which fires BEFORE the candidates are evaluated. The per-
candidate fixtures didn't satisfy that earlier gate, so the
helper short-circuited into the empty-state branch and never
ran the per-candidate logic. Cause: the spec lists the per-
candidate minimums (4 weeks for silent-project, etc.) as the
"detection threshold" but also lists a SEPARATE global
"warming up" threshold (< 8 weeks) as a sibling AC. The two
ACs read as independent in prose but are evaluated in series
by the helper. A fixture that satisfies only the per-candidate
local minimum is necessarily a "warming up" fleet under the
global gate. Fix: each per-candidate test fixture seeds enough
trailing data to clear BOTH the global empty-fleet gate AND
the candidate-specific threshold — for biggest-surprise that
meant adding 4 extra weeks of single-PR baseline rows beyond
the candidate's own 4-week / 5-PR / 5-trailing-PR fixture so
the helper's `COUNT(DISTINCT strftime('%Y-%W', date(fetched_at)))`
across MERGED is_agent rows clears the 8-week threshold. The
extra rows are below every candidate's per-test threshold so
they don't accidentally fire a different candidate. General
rule for this repo: any helper that gates a "are we ready to
report?" empty-state check BEFORE per-candidate evaluation
forces every per-candidate test fixture to also satisfy that
earlier gate. When designing the test suite, write the global
empty-state fixture FIRST (it's the simplest) then layer each
per-candidate fixture ON TOP — never assume the per-candidate
minimums also clear the global gate, because the global gate
is usually a "data maturity" threshold computed across all
rows, not the per-candidate subset. Same trap will bite any
future ticket whose helper composes a "report nothing until
the fleet has matured for N weeks" guard ahead of the actual
detection logic.

## 2026-06-15 — when an empty-state branch and a card's zero-denominator framing seem to overlap, pick a "first month meaningfully crossed the threshold" pivot

Symptom: while shipping ticket 0062 (monthly fleet retro card) I
hit a contradiction between two ACs. AC1's first-full-month branch
says "9 weeks of merged-PR data anchored so only ONE full calendar
month exists (no PRIOR full month to compare)" with `now =
2026-06-01` — which means thisMonth=May, lastMonth=April, and
the fixture is supposed to clear the global 8-distinct-trailing-
weeks-of-merged-PR-data gate AND render kind='first-full-month'.
But May only spans ~5 ISO weeks; 9 weeks of data all in May
literally cannot reach 8 distinct weeks. Meanwhile AC4's zero-
denominator edge case explicitly seeds April with 5 PRs + June
with 8 PRs + May empty AND expects kind='card' with a "no
comparison" framing on the affected delta — NOT first-full-month.
The two branches both fire when "lastMonth has 0 PRs", which
means the discriminator can't be "lastMonth has zero data".
Cause: the AC's prose conflates "no comparison anchor" with "the
fleet hasn't been around long enough to have a baseline" — they're
the same SQL question but different operator stories. The fix is
to pick a different pivot: a calendar month is a "full" month
when it crosses a small threshold (>= 3 merged PRs in the v1
implementation); first-full-month fires when `thisMonth` is the
FIRST chronological month to cross that bar (no earlier month
qualifies); otherwise the card renders and individual deltas can
still hit the "no comparison - last month had 0 PRs" framing
inline when prs_last_month / spend_last_month / etc happen to be
zero. With that pivot:
  - AC1 first-full-month fixture: May has 6 merges (full), April /
    March / Feb each have only 2 fringe merges (not full) — first
    chronological full month is May; thisMonth=May → first-full-
    month fires.
  - AC4 zero-denominator fixture: April has 5 merges (full), June
    has 8 (full) — first chronological full month is April,
    which is < thisMonth(June), so the card renders and the
    inline "no comparison" framing kicks in for the May=lastMonth
    delta.
General rule for this repo: when two empty-state branches share a
SQL signal (here: "lastMonth has zero PRs") but the operator-facing
copy differs ("first full month - check back next month" vs "no
comparison - last month was empty"), look for a SECOND signal that
discriminates which empty-state the operator is actually in. A
"this is the FIRST month the fleet has been active enough to be
meaningful" pivot is usually cleaner than "this month happens to
have zero comparison data" — the first one names a fleet maturity
threshold; the second one names a sampling fluke. The threshold
constant lives next to the helper as a named const (`MIN_FULL_
MONTH_PRS = 3`) so the next ticket can lift it without grepping
for a magic number. Same trap will bite any future ticket whose
helper composes a "first-N" empty-state alongside a "zero-
denominator-this-period" inline framing — the discriminator
question is always "what's the OPERATOR's story", not "what's
the SQL question".

## 2026-06-15 — static "route mounted before /api/ auth gate" greps must anchor on the if-statement, not the prose comment

Symptom: while shipping ticket 0063 I wrote an AC1 test asserting the
new `/embed/lessons.html` route is mounted BEFORE the `/api/` auth
gate via `SERVER_TS.indexOf('path.startsWith("/api/")')` and
`assert.ok(routeIdx < apiGateIdx, ...)`. The test failed even though
the route was wired correctly — because my own new comment block
INSIDE the embed-lessons cache layer carried the string
`path.startsWith("/api/")` verbatim (as descriptive prose:
"mounted BEFORE the path.startsWith(...) auth gate so they share the
no-token bypass posture"), and that prose appeared in source order
BEFORE the route-handler block, so `indexOf` returned the comment's
offset instead of the actual `if` statement's offset. Cause: a naked
`indexOf` over source text can't distinguish a prose mention of the
gate from the gate itself; the moment a sibling helper documents its
own posture in a comment that names the gate, the test's anchor
collapses to the comment's position. Fix: anchor on the actual
statement shape — `SERVER_TS.indexOf('if (path.startsWith("/api/"))')`.
The `if (` prefix is structurally absent from any reasonable comment
block that describes the gate (you write "the /api/ auth gate", you
don't write "the if (path.startsWith(...)) auth gate"). General rule
for this repo: when a static-grep test asserts ordering ("X mounted
BEFORE Y") it MUST anchor each side on a unique syntactic shape, not
a literal substring that could appear in a sibling helper's comment
block. Same trap will bite any future sibling-of-existing-helper
ticket whose comment block uses the canonical name of the structural
boundary it's positioned against — `path.startsWith` is a recurring
phrase in this repo, and so is `requireAuth(`, `composeEmbedFrameHeaders(`,
`globalThis.__fleet_*_invalidate__`. The fix is always to anchor on
a token that ONLY appears at the actual statement site (the `if (`
prefix here; a unique function-name like `serveX` elsewhere).

## 2026-06-15 — a new doctor check that calls `deps.fetchUrl` MUST sit inside the `!opts.offline` branch

Symptom: while shipping ticket 0064 I added `checkRateLimitWired(deps)`
to `runDoctor()` and placed the `checks.push(await checkRateLimitWired
(deps))` line OUTSIDE the existing `if (!opts.offline) { ... }` block
that wraps `checkFleetdLoaded`, `checkAdminSocket`, `checkGhAuth`,
`checkNtfyReachable`. Unit tests passed (every dep is stubbed via
`buildDeps`), but the AC8 subprocess CLI test that drives
`fleetctl doctor` with `FLEET_DOCTOR_OFFLINE=1` env var ran the new
check anyway and got a real `127.0.0.1:7070/embed/pulse.html` connect
attempt against a port nothing was listening on — surfacing a `warn`
on a clean tmpdir doctor run that the AC8 test didn't expect (and
that the operator would see as a phantom warning when running doctor
before starting the daemon for the first time). Cause: the
`opts.offline` flag is the contract between the CLI's hermetic test
mode and `runDoctor()`; any check that performs ACTUAL I/O (network,
launchctl, real fs probe) — even when routed through the injected
dep surface — must sit inside the `!opts.offline` branch, because the
PRODUCTION `defaultDeps()` wires the dep to a real binary / socket
and the CLI test's only knob to disable that is the `offline` flag.
The dep injection is for UNIT tests; the offline flag is for the
SUBPROCESS test. Both are needed for different scenarios. Fix: move
the new check inside the `if (!opts.offline) { ... }` block alongside
its siblings. Direct unit tests that exercise the check call
`checkRateLimitWired(deps)` straight (no opts.offline gate needed
because the unit test owns the dep surface end-to-end); aggregate
"new check appears in the rendering" tests pass `runDoctor(deps)`
with `offline: undefined` (the default) so the check is included via
the !offline branch. General rule for this repo: when adding a new
doctor check, decide first whether it performs real I/O in
production. If yes (any `deps.fetchUrl` / `deps.exec` against a real
binary), wrap the `checks.push(...)` call in `if (!opts.offline)`.
If no (a pure helper that reads injected state), put it outside.
Same trap will bite any future doctor check that wraps a real
socket / shell-out — the unit test will be green and the AC8
subprocess test silently triggers a real network attempt in CI.

## 2026-06-19 — testing `loadConfig()` with a non-default config: spawn a subprocess pinned to a tmpdir cwd, never write to the real cwd's `fleet-control.config.json`

Symptom: while shipping ticket 0068 I added an AC1 test that needed
to verify `loadConfig()` populates the new `operator.referredBy`
field when that field is present in `fleet-control.config.json`. The
obvious first cut wrote the test config to `process.cwd() +
"/fleet-control.config.json"` with the snapshot/restore pattern the
0065 operator-profile test already uses for its boot tests. The
test passed in isolation, then started flaking other test files
(operator-profile AC2/AC4/AC5) the moment another file ran in
parallel and also wrote to the same path. Cause: this is the
2026-06-11 lesson exactly — `process.cwd()` is shared across all
`node --test` workers on the same machine; the snapshot is per-
process, the file is global. The 2026-06-11 lesson's fix was "for
any branch test that depends on cfg, use a renderer-direct seam" —
but my AC1 test wasn't testing a renderer branch. It was testing
**`loadConfig()` itself**, which has no renderer-direct seam (it
reads `process.cwd()` and parses JSON; the only way to drive it
is to mutate something it reads). Fix: spawn a subprocess via
`spawnSync(process.execPath, ["--input-type=module", "-e", "..."],
{ cwd: <tmpdir> })` so the subprocess's `process.cwd()` is the
tmpdir, NOT the test runner's shared cwd. The subprocess writes
`<tmpdir>/fleet-control.config.json`, invokes `loadConfig()`,
prints the result to stdout, and exits — zero contamination of
the shared cwd. The test parses the stdout JSON for its
assertions. General rule for this repo: any test that needs to
drive `loadConfig()` against a NON-DEFAULT config file MUST run
`loadConfig()` in a subprocess pinned to an isolated `cwd` via
`spawnSync` — never write to the test-runner's `process.cwd() +
"/fleet-control.config.json"`. The renderer-direct seam covers
the "I need to drive a branch that depends on cfg" case; the
subprocess-pinned-cwd seam covers the "I need to drive the cfg
parser itself" case. Same trap will bite any future ticket that
introduces a new optional config field whose AC expects "load
this config; assert the parser returns the field populated".
The script form `"import { loadConfig } from \"<abs-path-to-
src/config.ts>\"; process.stdout.write(JSON.stringify(loadConfig
()))"` is the smallest working seam — no FLEET_DB_PATH knob
needed (the parser also reads that env var if set; passing it
along via the subprocess's env keeps the tmpdir DB hermetic).

## 2026-06-23 — module-level memo caches with date-string keys must be
reset between in-process boot tests; tmpdir DBs alone do not isolate

Symptom: while shipping ticket 0072 I wired a module-level memo cache
in `src/server.ts` for the new `fleetAnniversaryMoment` helper, keyed
by `now.toISOString().slice(0, 10)` (today's date) with a
`(MAX(pr.fetched_at), COUNT(*))` invalidation tuple. The renderer-
direct tests passed; each individual boot-path test also passed in
isolation. The moment two boot-path tests ran sequentially, the SECOND
test's `GET /share/anniversary/<token>` started 404'ing on a payload
the route SHOULD have rendered. Cause: each test calls `boot()` which
mints a fresh tmpdir + fresh DB at a new `FLEET_DB_PATH`, but the
module-level `anniversaryCache: Map<string, AnniversaryCacheEntry>`
lives in the SAME server-module process. The first boot wrote a cache
entry for today's date computed from DB-A's data; the second boot's
matching tuple call (different DB-B, but same date key) hit the cached
entry from DB-A — surfacing DB-A's payload (kind=`pr_100`) on DB-B's
freshly minted snapshot token. The mint then froze the wrong payload
into DB-B's snapshot row; the share route rendered `kind=none` (DB-B
was empty) and 404'd. The invalidation tuple wouldn't have saved us
either — both DBs returned `(MAX=null, COUNT=0)` for an empty
fixture, so the tuple matched and the cache hit. Fix: every test that
boots `startServer()` MUST call the cache reset hook (e.g.
`_resetAnniversaryCacheForTests()`) at the top of its `boot()` helper.
Centralised it in the boot harness so callers don't have to remember.
General rule for this repo: any module-level memo cache whose KEY is
"today's date" (or any other test-stable string) AND whose VALUE is
computed from the DB MUST expose a `_reset*ForTests` hook AND the
test harness MUST call it at every boot. The `FLEET_DB_PATH` env var
isolates the DB, but NOT the cache — the cache lives in the
server module's process memory and survives every `boot()` call
inside one `node --test` worker. Same trap will bite any future
ticket that adds a memo cache keyed by a calendar-day / week / month
string (LESSONS 2026-06-11 covers the same hazard for
`fleet-control.config.json` writes; this lesson is its in-process-cache
cousin).
