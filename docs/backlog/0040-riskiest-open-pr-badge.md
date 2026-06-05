---
id: 0040
title: Riskiest open PR badge - one home-page line names the PR most likely to hurt the operator next
status: in-progress
priority: P1
area: observability
created: 2026-06-05
owner: gtm-innovation
---

## User story

As a fleet operator opening the portal at 2pm with four open agent
PRs across three projects, I want one inline line on the home page
that names the single riskiest one - "Riskiest open PR: courtiq #312
(2 heals, supabase port-bind, 18h old) - tend first" - so that I
don't have to scroll all four project cards to triage; the surface
just tells me where to start.

## Why now (four lenses)

### Product Owner
The portal currently surfaces open PRs in two places:
- 0017 inbox lists them all without ranking
- 0023 PR card shows heal-count + first-fail reason on each card
Neither answers "which ONE should I tend RIGHT NOW?" - the operator
has to scan all of them mentally and rank. A `riskiestOpenPr(db,
now)` helper that fuses three signals already in the database
(heal_attempts from 0023, first-fail kind from 0023, and PR age
from `pr.fetched_at`) into a single deterministic risk score, then
surfaces the top result as a one-line inline at the home page,
collapses that mental ranking into a primitive. Per the cross-fleet
courtiq lesson "infra flakes shouldn't trigger code fixes," the
first-fail-kind dimension is load-bearing: a port-bind or
account-suspension first-fail is a "re-run, don't heal" verdict that
the score must encode. Pure composition - no new ingest, no new
schema. The badge hides itself when zero open agent PRs exist
(byte-identical home page).

### Stakeholder
Widens the moat on `observability` and the safety axis specifically.
Per the cross-fleet courtiq lesson "PRs getting stuck on infra
flakes (account suspensions, port binds, supabase start variance)
need a different response from PRs failing real tests," the risk
score is the structural way fleet-control encodes that distinction.
The signals (heal count, first-fail kind, age) live in
`control_audit` + `pr` + the existing 0023 PR-card payload - the
fleet-control SQLite is the ONLY place where all three coexist for
all projects. A GitHub-native view shows you ONE PR's CI state but
has no concept of heal-count or first-fail-kind taxonomy; an
Anthropic dashboard shows token spend but has no concept of "this
PR is stuck on infra, not code." The fused score is structurally
impossible outside fleet-control. That's the same moat-signal as
0035's $/PR (combine two halves no other tool has) and 0034's drift
detector (self-baseline no third party can compute), now on the
PRIORITY axis. The screenshot worth sharing: a single line at the
top of the portal naming the PR you should tend next - "no
dashboard scrolling, no triage spreadsheet, no Slack thread."

### User (operator at 2pm with 4 open PRs)
At the top of the home page, ABOVE the project grid, BELOW any
visible 0033/0037/0038 card, a single inline line:

```
Riskiest open PR: courtiq #312 (2 heals, supabase port-bind, 18h old)
                                                      [tend it now ->]
```

The label format: `<slug> #<number> (<heals> heal<s?>, <fail_kind>,
<age> old)`. The right-arrow link navigates to the project page
with the PR card scrolled into view (`/p/<slug>?pr=312`). On phone
the line wraps to two lines (label on top, link on bottom). When
zero open agent PRs exist the line is NOT in the DOM at all (no
skeleton, no whitespace). When all open PRs have score 0 (no heals,
no failed checks, age < 6h) the line renders a gentler form:
"Open PRs (3): all healthy" with a link to the inbox.

The score is the SUM of:
- `heal_attempts` * 4 (each heal is a strong signal something is
  hard about this PR)
- a `fail_kind_weight` lookup: `infra_flake` -> 1 (re-run resolves
  it), `red_test` -> 3 (code fix needed), `red_check_unknown` -> 2,
  `green` -> 0 (the PR is just waiting)
- `age_hours / 6` (older PRs hurt more - the operator's mental
  cost of context-switching grows with stale PRs)
The first-fail kind is read from the existing `control_audit`
stdout-tail of the latest heal attempt (per 0023's existing parsing
helper) OR from the `pr.ci_state` when no heal has been attempted.

### Growth
The screenshot worth sharing is the one-line surface itself:
"the portal tells you which of 4 open PRs to tend first, and why."
That artifact answers the prospective-operator question "what
happens when one of these PRs breaks?" more concretely than any
other surface. The "show me" pitch: "you don't have to context-
switch between four red PRs. Fleet-control names the riskiest one
and explains why in one line." More compelling than 0026's streak
(shape) or 0023's per-card heals (per-project triage) because it
puts the entire fleet's triage decision on one line. Per the
cross-fleet courtiq lesson "the share-worthy moment is the
structural impossibility for other tools," fusing heal-count +
fail-kind + age into a single ranked verdict is the kind of
opinionated surface only a tool with all three signals can build.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/views.ts` exports `riskiestOpenPr(db, now: Date):
      {open_count: number, all_healthy: boolean, top: {project_slug:
      string, project_name: string, pr_number: number, pr_title:
      string, pr_url: string, heal_attempts: number, fail_kind:
      "infra_flake" | "red_test" | "red_check_unknown" | "green",
      fail_detail: string | null, age_hours: number, score: number}
      | null, generated_at: string}`. Selects all `pr WHERE state =
      'OPEN' AND is_agent = 1`. For each, computes the score using
      the formula in AC2. Returns the top row by score descending
      (tiebreak by age descending). When `open_count === 0`,
      returns `{open_count: 0, all_healthy: false, top: null}`.
      When every row has score 0, returns `{open_count: N,
      all_healthy: true, top: null}`. Per LESSONS § "node:sqlite's
      .all() needs `as unknown as T[]`", every row narrowing uses
      the double-cast. Per LESSONS § "time-pinned tests must NOT
      derive seed timestamps from `new Date()`", every seed anchors
      to the pinned `now`. Test: seed 4 open PRs with known signals,
      assert the expected one wins; seed 0 PRs, assert empty; seed
      3 healthy PRs (no heals, green, age < 6h), assert
      `all_healthy: true` and `top: null`.
- [ ] Score formula (deterministic, no random): `score =
      heal_attempts * 4 + fail_kind_weight + Math.floor(age_hours
      / 6)`. The `fail_kind_weight` lookup is the literal map
      `{infra_flake: 1, red_test: 3, red_check_unknown: 2, green:
      0}`. A PR with `2 heals + red_test + 18h` scores `8 + 3 +
      3 = 14`. A PR with `0 heals + green + 24h` scores `0 + 0 +
      4 = 4`. Score is exposed on the returned row so the test
      can assert the exact integer. Test: seed PRs with each
      input combination, assert the score arithmetic to the
      integer.
- [ ] `fail_kind` classification: a new helper
      `classifyPrFailure(db, projectId, prNumber): {kind:
      ..., detail: string | null}` reads (a) the latest
      `control_audit` row where `action = 'heal'` and `target =
      'pr-<number>'` and parses its `stdout_tail` for known
      infra-flake substrings (`"address already in use"`,
      `"account is suspended"`, `"actions/checkout"` with
      `"403"`, `"supabase start"` + `"failed to bind"`,
      `"502 Bad Gateway"`), returning `infra_flake` with the
      matched substring as `detail`; else (b) reads `pr.ci_state`
      - `FAILURE` -> `red_test` (detail: first failed check
      name from the PR's recent runs IF present, else null);
      `PENDING` or `SUCCESS` -> `green`; anything else ->
      `red_check_unknown`. Per LESSONS § "shell-out modules
      need an injectable runner for tests", classifyPrFailure
      takes the db handle and runs SQL only - no shell-out.
      Per LESSONS § "no shell-string composition" (and its SQL
      analogue), all substring matches use literal string
      comparisons in JS, never composed into the SQL itself.
      Test: seed a heal-audit row with each infra-flake
      substring, assert each is classified; seed a heal-audit
      with a plain test failure, assert `red_test`; seed no
      heal-audit and `ci_state = FAILURE`, assert `red_test`;
      seed no heal-audit and `ci_state = SUCCESS`, assert
      `green`.
- [ ] Age computation: `age_hours = (now - pr.fetched_at) /
      3600000`, floored. Per LESSONS § "julianday() drifts ~10us
      per timestamp", any SQL-side age math uses the strftime
      decomposition; JS-side floor uses integer ms math. PRs
      with `fetched_at` newer than `now` (clock skew) clamp to
      0. Test: seed PRs with known `fetched_at` 18h before
      `now`, assert `age_hours = 18`.
- [ ] `GET /api/fleet/riskiest-pr` returns the shape from AC1.
      Requires `read` scope. Test: hit without auth -> 401;
      with `read` and 4 open PRs -> 200 with `top` populated;
      with zero open PRs -> 200 with `top: null` and
      `open_count: 0`; with all-healthy -> 200 with
      `all_healthy: true` and `top: null`.
- [ ] Caching: the route response sets `Cache-Control: max-age=
      30` (30s - the score can shift as soon as a heal lands).
      The handler memoises by `(open_pr_count_snapshot,
      latest_heal_ts_snapshot)` - a cheap two-value tuple
      computed via two `SELECT MAX(...)` queries before the
      main query, so the cache invalidates the moment a new
      heal or PR appears without polling the full result. Per
      LESSONS § "in-process dedup sets need an explicit reset
      hook for tests", expose
      `_resetRiskiestPrCacheForTests()` AND
      `_getRiskiestPrCacheBuildsForTests()` per LESSONS §
      "expose a build counter for cache-hit tests, not a
      fetcher swap". Test: two calls within 30s assert one
      build; insert a new heal-audit row, assert next call
      rebuilds; close a PR (open_count drops), assert next
      call rebuilds.
- [ ] `web/app.js` renders the badge on the home page as a
      single inline line ABOVE the project grid and BELOW any
      visible 0033/0037/0038 card. Layout: when `top` is set,
      the label `<slug> #<number> (<heals> heal<s?>,
      <fail_kind_label>, <age> old)` plus a right-arrow link
      to `/p/<slug>?pr=<number>`. The fail-kind label maps:
      `infra_flake` -> "infra flake (<detail>)", `red_test`
      -> "failing test", `red_check_unknown` -> "red check",
      `green` -> "awaiting review". When `all_healthy: true`
      and `open_count > 0`, render "Open PRs (<N>): all
      healthy" linked to `/inbox`. When `open_count === 0`,
      render NOTHING (no DOM element). Per LESSONS § "defence-
      in-depth secret redaction at the renderer boundary",
      every operator-visible string passes through
      `redactSecrets` before insertion. The container has
      `data-testid="riskiest-pr"`. Test: stub each of the
      three modes, assert the DOM matches; stub
      `open_count: 0`, assert the testid is absent.
- [ ] Project page anchor: when the URL hash includes
      `?pr=<number>` (e.g. `/p/courtiq?pr=312`), the project
      page scrolls the matching PR card into view AND
      highlights it briefly (a 2-second CSS class
      `pr-card-flash` that fades). Per the existing 0023 PR
      card surface, no new DOM is created - the existing PR
      card grows the highlight on mount when the query param
      matches. Test: navigate to `/p/courtiq?pr=312` with a
      seeded PR #312, assert the card has the highlight class
      applied; navigate without the param, assert no
      highlight.
- [ ] Mobile: at 375px viewport the badge wraps to two lines
      (label on the top line, "tend it now" arrow link on
      the second). At >=600px the badge is one line with the
      link right-aligned. No horizontal scroll (per 0011
      conventions). Test: assert via the existing mobile-
      portal text-level CSS contract at 375px and 600px.
- [ ] Quiet-hours integration: when 0030's `quietHoursActive`
      is `true` AND the badge's fail_kind is `infra_flake`,
      the badge is hidden (infra flakes do not need to wake
      the operator at midnight - the heal loop will retry
      naturally). For `red_test`, `red_check_unknown`, or
      `green`, the badge renders normally. Test: stub quiet
      hours active + infra_flake fail kind, assert the badge
      testid is absent; stub quiet hours active + red_test,
      assert the badge is present.
- [ ] Performance: `riskiestOpenPr(db, now)` against a fleet
      of 50 open PRs with 10 heal-audit rows each completes
      in under 25ms. The HTTP route end-to-end (cache miss)
      completes in under 70ms. Per LESSONS § "in-process
      startServer() tests need an empty-roots config + run-
      row seeds", the server-boot tests plant a tmp
      `fleet-control.config.json` in cwd and restore on
      cleanup. Test: seed the dataset, time both, assert
      thresholds (skip if `process.env.PERF !== "1"`).
- [ ] No new runtime deps. `tsc --noEmit` clean. No
      shell-string composition. No JSON-shape break to any
      existing `/api/...` route - the new
      `/api/fleet/riskiest-pr` is net-new; the home payload
      is unchanged (the badge fetches the new route on
      render). No schema migration - composes existing `pr`,
      `project`, and `control_audit` tables. Per LESSONS §
      "no backticks inside template-literal SQL strings",
      identifiers in any new SQL stay plain.

## Out of scope

- A multi-PR ranked list (top-3 riskiest). v1 is single-PR
  only - the operator's mental load is exactly ONE "what do
  I tend first" decision. Showing three reintroduces the
  scan-and-rank problem.
- An auto-heal action button ("retry this PR") in the badge
  itself. The badge is the SIGNAL surface; the project page
  is the ACTION surface (per the existing 0023 PR card).
  Mixing them weakens both.
- Per-project risk scores (each project card shows its own
  riskiest). The fleet-wide single line IS the value; per-
  project scores fragment.
- ML / weight-tuning surface. The score formula is
  deterministic and small enough to live in code; tuning
  knobs invite endless bikeshedding without operator value.
- Historical risk-score trend (a sparkline of "how risky was
  the riskiest PR over the last 14 days"). The badge is a
  point-in-time triage signal; trend lives in the digest.
- An ntfy push for "your riskiest PR just got more risky."
  The badge is a pull surface; pushing it would race the
  existing 0023 heal-count and 0008 anomaly pushes.
- LLM-authored "here's why this PR is risky" prose. The
  detail string from the fail-kind classification is the
  explanation; prose adds runtime cost.
- A "snooze this PR" surface. The operator already has the
  0017 inbox-dismissal mechanic; reusing it would be a
  follow-up if asked, not v1.
- A SECOND surface that ranks merged PRs by "regression
  risk" (e.g. "this merged PR is most likely to have
  broken something"). That's a categorically different
  problem (post-merge); v1 is open-PR triage only.

## Engineering notes

- `src/views.ts` - new `riskiestOpenPr(db, now)` helper
  next to `fleetView` / `costPerMergedPr`. The main query
  is `SELECT FROM pr JOIN project ON pr.project_id =
  project.id WHERE pr.state = 'OPEN' AND pr.is_agent = 1`.
  For each row, compute the score in JS (faster than a
  CTE for small N, and `classifyPrFailure` already requires
  a JS-side substring scan). Per LESSONS § "node:sqlite's
  .all() needs `as unknown as T[]`", every row narrowing
  uses the double-cast.
- `src/views.ts` - new `classifyPrFailure(db, projectId,
  prNumber)` helper. Reads `control_audit WHERE action =
  'heal' AND target = ? ORDER BY ts DESC LIMIT 1` for the
  latest heal attempt; if found, scans its
  `stdout_tail` for infra-flake substrings. Otherwise
  reads the PR's `ci_state`. The substring list lives as
  a module-level `const INFRA_FLAKE_PATTERNS: Array<{re:
  RegExp, label: string}>` so future patterns from the
  cross-fleet LESSONS file (LESSONS § "GitHub Actions
  silently stops firing", LESSONS § "supabase start
  port-bind") are one-line additions. Per LESSONS § "no
  shell-string composition", substring matches are JS
  RegExp tests, never SQL string concatenation.
- `src/server.ts` - one new route `GET
  /api/fleet/riskiest-pr`. Reuse the existing `read`
  scope middleware. The cache invalidation tuple is two
  `SELECT MAX(...)` queries (one over `pr.fetched_at`
  WHERE state='OPEN', one over `control_audit.ts` WHERE
  action='heal') - both have existing indexes (or get
  small ones if missing, see schema-migration note
  below). Per LESSONS § "expose a build counter for
  cache-hit tests, not a fetcher swap" - expose
  `_resetRiskiestPrCacheForTests()` and
  `_getRiskiestPrCacheBuildsForTests()`.
- `web/app.js` - new `renderRiskiestPr(data)` helper
  called from the existing home-page render path.
  Inserted ABOVE the project grid; when
  `open_count === 0` the helper returns an empty string
  so no DOM element is emitted. Also: a small URL-param
  handler in `renderProjectPage` that scrolls and
  highlights the matching PR card when `?pr=` is
  present. Per LESSONS § "defence-in-depth secret
  redaction at the renderer boundary", every operator-
  visible string passes through `redactSecrets`.
- `web/style.css` - one selector group for the badge
  (single-line inline layout, the fail-kind colour cue:
  red for `red_test`, amber for `infra_flake`, neutral
  for `green`) and one for the `pr-card-flash` 2s fade
  animation on the project page. Reuse existing CSS
  variables - no new palette.
- `tests/riskiest-pr.test.ts` (new) - one `test(...)`
  per AC checkbox. Per LESSONS § "time-pinned tests
  must NOT derive seed timestamps from `new Date()`",
  every seed timestamp anchors to the test's pinned
  `now`. The fail-kind tests seed heal-audit rows with
  each infra-flake substring from the cross-fleet
  LESSONS file. Per LESSONS § "in-process
  startServer() tests need an empty-roots config +
  run-row seeds", the server tests plant a tmp
  `fleet-control.config.json` in cwd and restore on
  cleanup. Per LESSONS § "anomaly tests need sigma > 0
  in the fixture" - not directly applicable here (no
  stddev), but the spirit applies: seed realistic
  signal counts (multiple heals, varied fail kinds)
  rather than degenerate fixtures.
- Schema migration: NO new tables. One optional new
  index `CREATE INDEX IF NOT EXISTS control_audit_action
  ON control_audit(action, ts DESC)` to make the
  classify lookup constant-time; add as an `ALTER
  TABLE` equivalent under the existing schema block in
  `src/db.ts`. Per LESSONS § "no backticks inside
  template-literal SQL strings", identifiers stay
  plain.
- No new runtime deps. Pairs with 0008 (anomaly
  detection is the WHEN-something-changed cousin; this
  is the WHAT-do-I-tend cousin), 0017 (the inbox lists
  all open PRs; this picks the worst one), 0020 (the
  alert engine surfaces hung runs; the badge surfaces
  hung PRs - different shapes of the same operator
  question), 0023 (the PR card supplies the per-PR
  heal-count and first-fail reason; the badge composes
  them into a verdict), 0030 (quiet hours hides
  infra_flake badges overnight), and 0036 (the cross-
  fleet LESSONS file is the canonical source for the
  infra-flake substring patterns).

## Implementation log

- 2026-06-05 [ship/0040] Branched `feat/0040-riskiest-open-pr-badge` off
  main, flipped status to `in-progress`, beginning test-first.
