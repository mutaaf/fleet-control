---
id: 0035
title: Cost per merged PR - the single number that frames spend in value terms
status: groomed
priority: P1
area: observability
created: 2026-06-03
owner: gtm-innovation
---

## User story

As a fleet operator at the end of the week looking at $28.40 of
Anthropic spend across six projects and asking "was it worth it?", I
want one headline number on the home page - "$2.37 per merged PR
(28 PRs, 14d)" - plus a small per-project breakdown that shows which
projects are cheap-to-ship and which are burning dollars per merge,
so that I can answer "is this fleet earning its keep?" in one glance
and decide where to invest more agent time vs where to throttle.

## Why now (four lenses)

### Product Owner
Every existing observability surface tells the operator the COST side
(0004 pricing, 0005 forecast, 0021 autopause, 0028 burndown, 0031 tool
mix) or the OUTPUT side (0012 digest, 0014 leaderboard, 0019 prs_merged,
0026 streak, 0033 glance) - but no single primitive divides one by the
other. The operator has to compute it in their head from two scrolls.
A `costPerMergedPr(db, days)` helper that reduces `cost_rollup_day` over
the window and divides by `COUNT(pr WHERE state='MERGED' AND is_agent=1)`
in the same window, surfaced as one headline + a per-project table,
collapses that mental math into a primitive. It also gives the autopause
(0021) and burndown (0028) a denominator: "this project's daily budget
is $4 but you're spending $6 per merge, so the cap is starving real
output" becomes a sentence the operator can write themselves. Pure
composition - no new ingest, no new table.

### Stakeholder
Widens the moat on `observability` and growth. This is the metric an
Anthropic billing dashboard structurally CANNOT compute: it knows your
total spend per project but has no concept of "merged PR" - that lives
in the operator's GitHub. A SaaS sitting on top of GitHub Actions sees
PR merge rate but not the spend. Only fleet-control, with both
`pr.state='MERGED'` AND `cost_rollup_day` in the same SQLite, can
divide them. Every prospective operator who sees their first
"$2.37/PR" card has the "wait, an outside tool literally cannot tell
me this" moment - the same moat-signal as 0034's drift detector but
on the VALUE axis instead of the SHAPE axis. Pair with the existing
README pitch and this becomes the single line in a Show HN post.

### User (operator at Friday 6pm)
Above the existing 0033 "Last 24 hours" card, a new compact line:

```
$2.37 per merged PR  ·  28 PRs shipped  ·  $66.36 spent  ·  last 14d
```

Tapping it opens `/cost-per-pr` with a small table:

```
project            14d $    PRs    $/PR    trend (vs prior 14d)
fleet-control      $24.12   12     $2.01    down 18%
courtiq            $31.04    9     $3.45    up 42%
digitalcraft        $4.80    4     $1.20    flat
agent-fleet         $6.40    3     $2.13    up 5%
                                            -----
fleet                $66.36   28    $2.37    down 6%
```

Rows sort by `$/PR` descending so the worst offender is at the top.
Projects with zero merges in window show `--` for `$/PR` (NOT `Infinity`)
and are sorted to the bottom. The trend arrow uses the same 14d-vs-prior-14d
comparison the digest already computes. On a phone the table collapses
to one row per project: slug + `$/PR` + trend glyph; tap a row to expand.

### Growth
The single tweet-sized artifact: "fleet-control: I run 6 autonomous
coding agents on my laptop. Today they shipped 28 PRs for $2.37
each. Local-only, zero runtime deps, [URL]." The number is the
hook; the moat justification is "no SaaS can compute this because
no SaaS has both halves of the ratio." More compelling than 0026's
streak heatmap (shape) or 0033's morning card (recap) because it
puts a dollar value on the OUTPUT of the fleet - the operator
ROI question that every prospective adopter actually asks first.
Per the cross-fleet courtiq lesson "the share-worthy moment is the
structural impossibility for other tools," this surface is purpose-
built for that screenshot.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/views.ts` exports `costPerMergedPr(db, opts?: {days?: number,
      now?: Date}): {window: {start: string, end: string, days: number},
      fleet: {spent_usd: number, prs_merged: number, dollars_per_pr:
      number | null, trend_pct: number | null}, projects: Array<{slug:
      string, spent_usd: number, prs_merged: number, dollars_per_pr:
      number | null, trend_pct: number | null}>, generated_at: string}`.
      `days` defaults to 14, capped at 90. `spent_usd` is the sum of
      `cost_rollup_day.usd` over the window per project. `prs_merged`
      is `COUNT(*) FROM pr WHERE state='MERGED' AND is_agent=1 AND
      fetched_at >= window.start` per project. `dollars_per_pr` is
      `spent_usd / prs_merged` when `prs_merged > 0` else `null`.
      `trend_pct` is `(current_$/PR - prior_$/PR) / prior_$/PR * 100`
      where prior is the SAME `days` window immediately preceding;
      `null` when either side has zero merges. Per LESSONS § "node:
      sqlite's .all() needs `as unknown as T[]`", every row narrowing
      uses the double-cast. Per LESSONS § "time-pinned tests must NOT
      derive seed timestamps from `new Date()`", every seed in the
      test anchors to the test's pinned `now`. Test: seed
      fleet-control with $24/12 PRs and courtiq with $31/9 PRs in the
      14d window plus matching prior-14d data, assert the fleet
      headline `dollars_per_pr ~= 2.37` and the project rows sort
      correctly.
- [ ] Division-by-zero guard: a project with `spent_usd > 0` but zero
      merged PRs in window returns `dollars_per_pr: null` (NOT
      `Infinity`, NOT `0`, NOT `NaN`). The fleet rollup excludes that
      project's spend from the headline `$/PR` numerator IF the
      fleet's total `prs_merged === 0`, returning `null` at the top
      level too. Test: seed one project with $5 spent and zero
      merges; assert `dollars_per_pr === null` for both that row and
      the fleet headline.
- [ ] Insufficient-baseline guard for trend: when the prior 14d
      window has < 3 merged PRs OR < $1 spent for a given project,
      `trend_pct` is `null` for that row (not a misleading
      percentage from a sparse base). Test: seed a project with no
      prior-window data, assert `trend_pct: null` and that the SPA
      renders an em-dash for that cell.
- [ ] `GET /api/fleet/cost-per-pr?days=14` returns the shape.
      Requires `read` scope. `days` is parsed via the same
      `clampDays()` helper used by the leaderboard (0014); invalid
      values fall back to 14. Test: hit without auth -> 401; with
      `read` and `days=30` -> 200 plus a 30-day window; with
      `days=999` -> 200 with window clamped to 90 days.
- [ ] Caching: the route response sets `Cache-Control: max-age=300`
      (5 min - this number changes slowly) and the handler memoises
      by `(days, now-rounded-to-5-min)` in a module-level Map. Per
      LESSONS § "in-process dedup sets need an explicit reset hook
      for tests", expose `_resetCostPerPrCacheForTests()` AND
      `_getCostPerPrCacheBuildsForTests()` per LESSONS § "expose a
      build counter for cache-hit tests, not a fetcher swap". Test:
      two calls within 5min assert the build counter increments
      once; advance 6min, assert another increment.
- [ ] `web/app.js` renders a one-line summary on the home page,
      immediately ABOVE the 0033 yesterday-glance card so it sits
      first in the visual hierarchy. Text:
      `$<dollars_per_pr> per merged PR · <prs_merged> PRs · $<spent>
      spent · last <days>d`. When `dollars_per_pr === null`, the
      line reads `No merged PRs yet · $<spent> spent · last <days>d`
      (no division). Per LESSONS § "defence-in-depth secret
      redaction at the renderer boundary", numerical formatting
      happens after `redactSecrets` (no secrets in this surface,
      but the pattern stays consistent). The summary line has
      `data-testid="cost-per-pr-summary"` for stable phone-test
      hooks. Tapping anywhere on the summary navigates to
      `/cost-per-pr`. Test: stub each branch (with PRs, without
      PRs), assert the rendered DOM text and the testid.
- [ ] The `/cost-per-pr` detail route renders a sortable table with
      columns: `project | 14d $ | PRs | $/PR | trend`. Default sort
      is `$/PR` descending; clicking a column header toggles ascend/
      descend. Rows with `dollars_per_pr === null` always sort to
      the bottom regardless of direction. The fleet rollup is the
      last row, visually separated (CSS border-top). Per LESSONS §
      "node:sqlite's .all() needs `as unknown as T[]`", any row
      narrowing in the handler uses the double-cast. Test: stub
      the API with 4 projects of known costs, assert the rendered
      row order; click `PRs` header, assert re-sort; click again,
      assert reverse.
- [ ] Mobile: at 375px viewport the table collapses to one row per
      project rendering only `slug + $/PR + trend glyph`; tapping
      a row expands to show the full 4 columns inline. The
      fleet-rollup row is always expanded. No horizontal scroll
      (per 0011 conventions). Test: assert via the existing mobile-
      portal text-level CSS contract at 375px and 600px.
- [ ] Quiet-hours integration: the home-page summary line does NOT
      change appearance during quiet hours (this is a pull surface,
      not a push one - quiet hours per 0030 gate notifications
      only). Test: stub `quietHoursActive: true`, assert the
      summary text is byte-identical to non-quiet rendering.
- [ ] Performance: `costPerMergedPr(db, {days: 14})` against a
      fleet of 10 projects with 90 days of PR + cost data
      completes in under 50ms. The HTTP route end-to-end (cache
      miss) completes in under 120ms. Per LESSONS § "julianday()
      drifts ~10us per timestamp; decompose with strftime for
      sub-ms diffs", window arithmetic uses the strftime
      decomposition. Per LESSONS § "in-process startServer()
      tests need an empty-roots config + run-row seeds", the
      server-boot tests plant a tmp `fleet-control.config.json`
      in cwd and restore on cleanup. Test: seed the dataset,
      time both, assert thresholds (skip if `process.env.PERF
      !== "1"`).
- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-string
      composition. No JSON-shape break to any existing
      `/api/...` route - the new `/api/fleet/cost-per-pr` route
      is net-new; the home payload is unchanged (the summary
      line fetches the new route on render, NOT inlined). No
      schema migration - reads existing `pr`, `cost_rollup_day`,
      and `project` only.

## Out of scope

- A per-COMMIT cost figure. v1 is per-PR only - commits inside a
  PR are not the operator's billable unit; the PR is. A
  commit-level view requires a different join and adds noise for
  zero new insight.
- Cost-per-LINE-of-diff. The PR's `additions+deletions` ratio is
  available but conflates one-line refactors with multi-thousand-
  line ones in a misleading way; the operator already has the
  digest's `lines_per_pr` if they want that lens.
- Filtering by author/agent. The fleet currently runs one agent
  per project; a per-author breakdown is a clean follow-up if
  the multi-agent case becomes real.
- Trend lines longer than 14d-vs-prior-14d. The digest (0012)
  already covers weekly; a multi-month trend chart is a separate
  surface.
- Auto-pausing projects whose `$/PR` crosses a threshold. The
  autopause (0021) is on absolute daily spend; layering a ratio-
  based pause adds two more knobs and a confusing interaction
  matrix. v1 is diagnostic only - operator decides.
- Cost attribution to NON-merged PRs (the heal-loop cost on a
  red PR). All in-flight cost is rolled into the project total;
  separating "cost of merged work" from "cost of healing"
  requires a different join via `pr.state` filtering at the
  RUN level, which is a follow-up.
- LLM-authored "why is this project expensive" hints. The
  table answers `which`; the operator reads the digest or
  drift (0034) for `why`.

## Engineering notes

- `src/views.ts` - new `costPerMergedPr(db, opts)` helper next to
  the existing `forecastFor`, `projectBurndown`, and `fleetStreak`
  exports. Two SQL queries: one for spend (existing
  `cost_rollup_day` shape) and one for merge counts (existing
  `pr` shape). The division and trend are pure JS over the SQL
  results. Per LESSONS § "node:sqlite's .all() needs `as unknown
  as T[]`", every row narrowing uses the double-cast. Per LESSONS
  § "julianday() drifts ~10us per timestamp", window arithmetic
  uses the strftime decomposition.
- `src/server.ts` - one new route `GET /api/fleet/cost-per-pr`.
  Reuse the existing `read` scope middleware. The 5-min memo
  cache is a module-level `Map<string, {value, expires_at}>`;
  per LESSONS § "expose a build counter for cache-hit tests, not
  a fetcher swap" - expose `_resetCostPerPrCacheForTests()` and
  `_getCostPerPrCacheBuildsForTests()`.
- `web/app.js` - new `renderCostPerPrSummary(data)` called from
  the existing home-page render path, inserted ABOVE the
  yesterday-glance card slot. New `renderCostPerPrDetail(data)`
  for the `/cost-per-pr` route, hooked into the existing hash
  router. Pure DOM-string concatenation; no new template engine.
  The table sort handler is a vanilla `addEventListener` per
  header `<th>`.
- `web/style.css` - one selector group for the summary line and
  the detail table. Reuse existing CSS variables - no new
  palette. The table's fleet-rollup row uses an existing border-
  top style; the expanded-row mobile pattern reuses the 0023 PR
  card's expand convention.
- `tests/cost-per-pr.test.ts` (new) - one `test(...)` per AC
  checkbox. Per LESSONS § "time-pinned tests must NOT derive
  seed timestamps from `new Date()`", every seed timestamp is
  anchored to the test's pinned `now`. Per LESSONS § "in-process
  startServer() tests need an empty-roots config + run-row
  seeds", the server tests plant a tmp `fleet-control.config.
  json` in cwd and restore on cleanup. Per LESSONS § "anomaly
  tests need sigma > 0 in the fixture", the trend tests seed
  realistic spread across the prior window (not flat) so the
  trend percentage is geometrically meaningful.
- No new runtime deps. No schema migration - composes existing
  `pr`, `cost_rollup_day`, and `project` tables only. Pairs
  with 0012 (digest's trend math is the reference for the
  14d-vs-prior-14d comparison), 0014 (leaderboard's
  `clampDays` is reused for the days param), 0019
  (prs_merged-from-runs guarantees the merge count is sourced
  consistently), 0021 (the $/PR ratio gives the daily-budget
  cap a value-side denominator), 0028 (burndown shows the
  trajectory; $/PR shows the efficiency), and 0033 (the home
  page now reads top-to-bottom: cost-per-PR summary -> last
  24h glance -> inbox -> projects).

## Implementation log

(Appended by the implementation-dev agent during execution.)

- YYYY-MM-DD - branch `feat/0035-...` opened
- YYYY-MM-DD - failing test added in `tests/cost-per-pr.test.ts`
- YYYY-MM-DD - PR #N opened, CI [state]
- YYYY-MM-DD - merged to main
