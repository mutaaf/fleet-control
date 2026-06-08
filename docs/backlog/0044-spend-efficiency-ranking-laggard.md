---
id: 0044
title: Spend-efficiency ranking - rank projects by $/merged-PR and diagnose the laggard
status: in-progress
priority: P2
area: observability
created: 2026-06-07
owner: gtm-innovation
---

## Implementation log

- 2026-06-07: branched `feat/0044-spend-efficiency-ranking-laggard`. Producer
  audit confirms `pr.state = 'MERGED'` + `is_agent = 1` (per `costPerMergedPr`
  line 1875 and `src/ingest/prs.ts:164`), `run.outcome` is lowercase
  (`'healed'`, `'self-cancel'`, surfaced by `src/ingest/transcripts.ts`),
  `anomaly.kind = 'self_drift'` (snake_case, per `src/drift.ts`), and the
  `infra_flake` signal reuses the existing `classifyPrFailure` helper which
  scans the latest `control_audit` heal-row for that PR. The new helper
  + route + SPA card compose entirely over already-shipped tables — no
  schema migration, no new ingest path.

## User story

As a fleet operator at 2pm wondering which of my 5 projects is
"costing the most for the least", I want one inline card on the
home page that ranks all projects by `merged_prs / $spent` over the
trailing 14 days, calls out the LAGGARD by name, and attributes
the under-performance to a SPECIFIC structural cause from data
already in the database - "almanac: $4.20/PR (3x fleet median).
Why: 4 healed runs this week (vs fleet median 1), 2 self-cancels.
Look at the heal causes." - so that I don't have to open five
project pages and compare numbers; the portal tells me which
project is the worst spend per outcome AND why, in one card.

## Why now (four lenses)

### Product Owner
0035 (cost per merged PR) already computes `cost_per_merged_pr`
per project; what 0035 does NOT do is RANK projects against each
other or DIAGNOSE the laggard. The operator currently has to open
each project page and mentally compare. The smallest meaningful
unit of value: one card, one ranked list, one laggard, one
structural reason. The diagnosis is composed from existing
signals: heal count (0023's `pr.heal_attempts`), self-cancel
outcome (existing `run.outcome = 'self-cancel'`), drift state
(0034's `anomaly.kind = 'self_drift'`), and infra-flake count
(0040's `classifyPrFailure` `kind = 'infra_flake'`). Pure
composition over already-shipped data sources; no new schema; no
new ingest path. The card hides itself when fewer than 3
projects have merged at least one PR in the window (need a
meaningful median to define a laggard).

### Stakeholder
Widens the moat on the EFFICIENCY axis - which is the single
most-asked operator question fleet-control does not yet answer in
one glance. 0035 says "this project's $/PR is X"; this ticket
says "AND it's 3x the fleet median because of THIS reason". The
fleet-control SQLite is the only place where (a) per-project
cost (b) per-project merged-PR count (c) per-project heal count
(d) per-project drift state (e) per-project self-cancel rate all
coexist. A GitHub-native view shows you ONE PR's cost (it does
not); an Anthropic dashboard shows you a project's tokens (one
project at a time, no merge outcomes); NONE of them fuse cost +
outcomes + failure shape into a ranked verdict. Per the cross-
fleet courtiq lesson "fused signals only fleet-control can
compute," this is exactly that shape on the EFFICIENCY axis. The
screenshot worth sharing: a single inline card naming the
laggard project and the structural reason - the kind of
opinionated surface only a fused-signal tool can produce.

### User (operator at 2pm, scanning the home page)
On the home page, ABOVE the project grid, BELOW any visible
0033/0037/0038 cards, BELOW the 0040 riskiest-PR badge, an
inline card:

```
Spend efficiency (last 14 days)
  fleet median: $0.32/PR        fleet 14d spend: $14.20

  Laggard: almanac  $4.20/PR (3x median)
    Why: 4 healed runs (median 1) + 2 self-cancels + 1 drift open
    Look here -> /p/almanac (heal causes)

  Leaderboard:
    courtiq      $0.18/PR  +6 PRs
    fleet-control $0.22/PR  +4 PRs
    digitalcraft $0.31/PR  +2 PRs
    courtiq2     $0.45/PR  +1 PR
    almanac      $4.20/PR  +1 PR   <- laggard
```

The "Why" line is composed from 1-3 structural signals, chosen
by largest-deviation-from-fleet-median first. The "Look here"
link navigates to the project page anchored on the section that
explains the cited signal. When fewer than 3 projects have
merged a PR in the window, the entire card is invisible (no
meaningful median). On phone, the card collapses: the median
line wraps under the title, the laggard becomes the only
visible row, the leaderboard collapses behind a "show all (N)"
tap-target.

### Growth
The screenshot worth sharing: the card naming the laggard with
its structural reason - "almanac: $4.20/PR (3x median). 4
healed runs + 2 self-cancels". That artifact is more compelling
than 0035's per-project number (the headline without
explanation) because it answers the operator's actual question:
"WHICH project should I look at, and WHY." Per the cross-fleet
courtiq lesson "the share-worthy moment is the opinionated
verdict," the laggard call-out is the kind of surface that
makes a prospective adopter ask "how does it know that?"

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: when
this spec names a column value literally (`pr.state = 'MERGED'`,
`outcome = 'self-cancel'`, `outcome = 'healed'`, `anomaly.kind =
'self_drift'`), the implementing dev MUST grep
`src/ingest/prs.ts` (line 164) and `src/ingest/runs.ts` and
`src/control.ts` for the producer's actual casing before writing
the SELECT. Per LESSONS 2026-06-05 "groomer prose can disagree
with the schema; the schema wins": the producer is the contract.
Existing 0035, 0034, 0023 helpers are precedent - copy their
casing.

- [ ] `src/views.ts` exports `spendEfficiencyRanking(db, now:
      Date, opts?: {windowDays?: number}): {fleet_median_per_pr:
      number | null, fleet_total_spend_usd: number, fleet_total_prs:
      number, projects: Array<{project_slug: string,
      project_name: string, merged_prs: number, spend_usd: number,
      cost_per_pr_usd: number | null, ratio_to_median: number |
      null}>, laggard: {project_slug: string, project_name: string,
      cost_per_pr_usd: number, ratio_to_median: number, why:
      Array<{signal: "heals" | "self_cancel" | "drift" |
      "infra_flake", value: number, fleet_median: number,
      detail: string}>, link: string} | null, window_days: number,
      generated_at: string}`. Walks `pr WHERE state =
      <merged-casing>` and `cost_rollup_day` over the trailing
      `opts.windowDays || 14` days. Computes `cost_per_pr_usd =
      spend_usd / merged_prs` per project (null when
      `merged_prs === 0`). `ratio_to_median` is per-project
      `cost_per_pr / fleet_median_per_pr`. The fleet median uses
      only projects with `merged_prs >= 1`. Per LESSONS §
      "node:sqlite's .all() needs `as unknown as T[]`", every
      row narrowing uses the double-cast. Per LESSONS § "time-
      pinned tests must NOT derive seed timestamps from `new
      Date()`", every seed anchors to the pinned `now`. Test:
      seed 5 projects with known cost + merged PRs, assert
      each `cost_per_pr_usd` and `ratio_to_median` exactly;
      seed 2 projects, assert `laggard: null` (under the
      3-project threshold).
- [ ] Laggard selection rule: the laggard is the project with
      the HIGHEST `ratio_to_median` whose `merged_prs >= 1`,
      provided that ratio is `> 1.5`. When NO project's ratio
      exceeds 1.5, `laggard: null` (the fleet is balanced,
      naming a laggard would be misleading). When MULTIPLE
      projects tie at the top ratio, the one with higher
      ABSOLUTE `cost_per_pr_usd` wins. Test: seed a fleet
      where all projects sit within 1.5x of median, assert
      `laggard: null`; seed one outlier at 3x, assert it's
      the laggard.
- [ ] "Why" composition: the `why` array carries 1-3 entries,
      ordered by ABSOLUTE deviation from fleet median
      descending. Sources:
      1. **heals**: count of `run.outcome = 'healed'` runs
         in the window per project. Fleet median computed
         the same way. `detail` = "<N> healed runs (median
         <M>)".
      2. **self_cancel**: count of `run.outcome =
         'self-cancel'` runs in the window per project.
         `detail` = "<N> self-cancel<s?>".
      3. **drift**: count of OPEN `anomaly.kind =
         'self_drift'` rows per project. `detail` = "<N>
         drift open" (omitted when 0).
      4. **infra_flake**: count of PRs in the window whose
         classifier (per 0040) returned `infra_flake`.
         `detail` = "<N> infra-flake PR<s?>".
      Only signals where the laggard's value is STRICTLY
      GREATER than the fleet median are surfaced. When zero
      signals qualify, `why: []` (the card shows the ratio
      but no structural reason - rare; signals that the
      laggard is expensive for a non-structural reason).
      Per LESSONS § "anomaly tests need sigma > 0 in the
      fixture, not just mean != value" - seed the laggard
      well above the fleet median on at least one signal
      so the SELECT returns a non-empty `why`. Test: seed
      a fleet with one project that has 4 heals vs median
      1, 2 self-cancels vs median 0, 1 drift vs median 0,
      assert the `why` array carries all three in order
      of deviation magnitude.
- [ ] `GET /api/fleet/spend-efficiency` returns the shape
      from AC1. Requires `read` scope. Accepts an optional
      `?window=<days>` (7-90, default 14). Test: hit without
      auth -> 401; with `read` -> 200 with the expected
      shape; pass `?window=7`, assert the window narrows;
      pass `?window=100`, assert 400 (out of range).
- [ ] Caching: the route response sets `Cache-Control:
      max-age=900` (15 min - the median moves slowly; the
      laggard rarely flips within a 15-min window). The
      handler memoises by `(window_days, latest_run_id,
      latest_merged_pr_id)` - a three-value tuple that
      invalidates the moment a new run or merged PR lands.
      Per LESSONS § "in-process dedup sets need an explicit
      reset hook for tests", expose
      `_resetSpendEfficiencyCacheForTests()` AND
      `_getSpendEfficiencyCacheBuildsForTests()` per
      LESSONS § "expose a build counter for cache-hit
      tests, not a fetcher swap". Test: two calls within
      15 min assert one build; insert a new
      `state='MERGED'` PR, assert next call rebuilds.
- [ ] `web/app.js` renders the card on the home page
      BELOW any 0033/0037/0038 cards, BELOW the 0040
      riskiest-PR badge, ABOVE the project grid.
      Container `data-testid="spend-efficiency-card"`.
      Layout: title "Spend efficiency (last <N> days)",
      one line "fleet median: $<X>/PR / fleet 14d spend:
      $<Y>", one laggard block (project name, ratio,
      cost-per-PR, why-line, link), one leaderboard
      block (every project ranked by ascending
      cost-per-PR with a "<- laggard" marker on the
      worst). When `laggard === null` the laggard block
      is OMITTED but the leaderboard still renders.
      When the entire response has `projects.length <
      3` (insufficient signal), the card is NOT in the
      DOM at all (no `data-testid="spend-efficiency-
      card"` element). Per LESSONS § "defence-in-depth
      secret redaction at the renderer boundary", every
      operator-visible string passes through
      `redactSecrets`. Test: stub a 5-project fleet
      with a clear laggard, assert the DOM contains
      the testid, the laggard block, and the
      leaderboard rows in order; stub a 2-project
      fleet, assert the testid is absent.
- [ ] Project page anchor: when the laggard's "Look
      here" link is tapped, the project page opens
      with a query param `?focus=<signal>` (e.g.
      `?focus=heals`). The project page highlights
      the matching section briefly (a 2-second CSS
      `focus-flash` class on the runs list, the
      anomaly list, or the inbox section as
      appropriate). Per 0040's precedent (`?pr=<n>`
      scroll-and-highlight), the same pattern applies
      here - reuse the existing
      `pr-card-flash` CSS variable for the
      animation. Test: navigate to
      `/p/almanac?focus=heals` with seeded heal runs,
      assert the runs section has the highlight
      class; navigate without the param, assert no
      highlight.
- [ ] Mobile: at 375px viewport the card collapses
      the leaderboard behind a "show all (N)" tap-
      target; the laggard block remains fully visible.
      The fleet-median line wraps under the title.
      No horizontal scroll (per 0011 conventions).
      At >=600px the leaderboard renders inline as a
      table. Test: assert via the existing mobile-
      portal text-level CSS contract at 375px and
      600px.
- [ ] Quiet-hours integration: when 0030's
      `quietHoursActive` is `true`, the card renders
      WITHOUT the "Look here" call-to-action (the
      operator should not be context-switching at
      midnight). The laggard verdict is still
      visible (the operator opened the portal
      voluntarily); the action prompt is suppressed.
      Per the existing 0030 pull-vs-push contract,
      this is the right shape: information visible,
      action suppressed. Test: stub quiet hours
      active, assert the laggard block lacks the
      `look-here-link` testid; stub quiet hours
      inactive, assert it's present.
- [ ] Single-project fleet edge case: when only ONE
      project has merged a PR in the window AND
      `windowDays === 14`, the card is invisible
      (no median, no laggard). When `windowDays`
      is widened to 90, the card may reveal more
      projects (different window threshold). Test:
      seed a single-project fleet, assert the card
      is absent at default window; widen the
      window via `?window=90`, assert the card
      remains absent.
- [ ] Performance: `spendEfficiencyRanking(db, now)`
      against a fleet of 50 projects each with 10
      merged PRs and 20 healed runs completes in
      under 30ms. The HTTP route end-to-end (cache
      miss) completes in under 80ms. Per LESSONS §
      "in-process startServer() tests need an empty-
      roots config + run-row seeds", server-boot
      tests plant a tmp
      `fleet-control.config.json` in cwd and
      restore on cleanup. Test: seed the dataset,
      time both, assert thresholds (skip if
      `process.env.PERF !== "1"`).
- [ ] No new runtime deps. `tsc --noEmit` clean. No
      shell-string composition. No JSON-shape break
      to any existing `/api/...` route - the new
      `/api/fleet/spend-efficiency` is net-new; the
      home payload is unchanged (the card fetches
      the new route on render). No schema migration
      - composes existing `pr`, `cost_rollup_day`,
      `run`, `anomaly` tables. Per LESSONS § "no
      backticks inside template-literal SQL
      strings", identifiers stay plain. Per
      LESSONS § "julianday() drifts ~10us per
      timestamp", any timestamp diff uses strftime
      decomposition.

## Out of scope

- An ML / regression model that learns project-
  level cost-vs-outcome curves. The ratio-to-median
  + signal-cascade verdict is deterministic and
  small - tuning knobs invite endless
  bikeshedding without operator value.
- A "send the laggard a notification" push. The
  card is a pull surface; pushing would race the
  existing 0009 ntfy budget alerts.
- Auto-throttling the laggard project (lowering
  its cadence). The card is a SIGNAL surface; the
  ACTION surface is the existing pause / resume
  controls per project. Mixing them weakens both.
- A historical "how the leaderboard has changed
  over the last 4 weeks" trend. The card is
  point-in-time; trend lives in the digest
  (0012).
- A cross-fleet (multi-operator) ranking
  surface. Single-fleet by design.
- LLM-authored "here's why this project is the
  laggard" prose. The composed `why` array IS
  the explanation; prose adds runtime cost.
- A per-phase cost-per-PR ratio (ship vs groom
  vs review). The card is project-level; phase-
  level lives on the project page (0031 tool-mix
  sparkline is the precedent).
- Auto-publishing the laggard call-out as a
  receipts (0041) artifact. Receipts are
  CELEBRATION; the laggard verdict is private
  introspection.
- A "compare project A vs project B" custom
  comparator. The card is fleet-wide; bilateral
  comparison is over-engineering.

## Engineering notes

- `src/views.ts` - new
  `spendEfficiencyRanking(db, now, opts)` helper
  next to the existing `costPerMergedPr` (line
  1875) and `fridayWrap`. The main query is two
  passes: (1) per-project `SUM(cost_usd)` from
  `cost_rollup_day` over the window, (2)
  per-project `COUNT(*)` from `pr WHERE state =
  <merged-casing>` over the window. The fleet
  median is computed JS-side (small N). Per
  LESSONS § "node:sqlite's .all() needs
  `as unknown as T[]`", every row narrowing uses
  the double-cast. Per LESSONS § "julianday()
  drifts ~10us per timestamp", any timestamp
  diff uses strftime decomposition.
- `src/views.ts` - new `composeLaggardWhy(db,
  projectId, now, windowDays, fleetMedians)`
  internal helper that returns the
  `Array<{signal, value, fleet_median, detail}>`
  ordered by absolute deviation. PRODUCER-VS-
  SPEC NOTE: grep `src/ingest/runs.ts` for the
  actual `outcome` casing (`'healed'`,
  `'self-cancel'`) the production ingester
  writes before composing the SELECT. Per
  LESSONS 2026-06-05 "groomer prose can
  disagree with the schema; the schema wins" -
  the producer is the contract.
- `src/server.ts` - one new route
  `GET /api/fleet/spend-efficiency`. Reuse the
  existing `read` scope middleware. The
  `?window=` param is validated against [7,
  90] before use. The cache invalidation tuple
  is a three-value `(window_days,
  latest_run_id, latest_merged_pr_id)`. Per
  LESSONS § "expose a build counter for cache-
  hit tests, not a fetcher swap" - expose
  `_resetSpendEfficiencyCacheForTests()` and
  `_getSpendEfficiencyCacheBuildsForTests()`.
- `web/app.js` - new
  `renderSpendEfficiencyCard(data)` helper
  called from the existing home-page render
  path. Inserted BELOW any 0033/0037/0038
  cards and the 0040 badge, ABOVE the project
  grid. When `projects.length < 3` the helper
  returns an empty string. Per LESSONS §
  "defence-in-depth secret redaction at the
  renderer boundary", every operator-visible
  string passes through `redactSecrets`. The
  laggard's "Look here" link uses the
  existing 0040 `?<focus|pr>=` query-param
  pattern for scroll-and-highlight on the
  project page.
- `web/style.css` - one selector group for
  the card layout (single column at 375px,
  inline at >=600px); one for the
  leaderboard table; one for the laggard
  highlight (reuse the 0040 `pr-card-flash`
  CSS variable for the `focus-flash`
  animation on project-page anchor). No new
  CSS variables.
- `tests/spend-efficiency.test.ts` (new) -
  one `test(...)` per AC checkbox. Per
  LESSONS § "time-pinned tests must NOT
  derive seed timestamps from `new Date()`",
  every seed anchors to the test's pinned
  `now`. Per LESSONS § "in-process
  startServer() tests need an empty-roots
  config + run-row seeds", server-boot
  tests plant a tmp
  `fleet-control.config.json` in cwd and
  restore on cleanup. Per LESSONS §
  "anomaly tests need sigma > 0 in the
  fixture" - seed multiple projects with
  varied heal / self-cancel counts so the
  `why` cascade has signal to surface.
- Schema migration: NO new tables. Composes
  existing `pr`, `cost_rollup_day`, `run`,
  `anomaly` tables. Per LESSONS § "no
  backticks inside template-literal SQL
  strings", identifiers stay plain.
- No new runtime deps. Pairs with 0035
  (per-project cost-per-PR is the primitive
  this ticket aggregates), 0040 (riskiest-PR
  badge is the per-PR triage analogue; this
  is the per-PROJECT efficiency analogue),
  0034 (self-drift is one of the signal
  sources for the `why` cascade), 0023 (the
  heal-attempts column is the primary `why`
  signal), 0021 (the budget autopause is
  the related cost-axis surface but
  project-internal; this is fleet-relative),
  and 0030 (quiet-hours suppresses the
  action-prompt but not the verdict).
