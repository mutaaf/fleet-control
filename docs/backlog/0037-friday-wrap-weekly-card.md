---
id: 0037
title: Friday wrap - one weekly card recaps the fleet's week so the operator closes the laptop on a high
status: shipped
priority: P2
area: portal
created: 2026-06-03
owner: gtm-innovation
---

## User story

As a fleet operator at 4:50pm on Friday about to close the laptop
for the weekend, I want one card at the top of the home page that
appears only on Fridays summarising what the fleet did this week -
"shipped 17 PRs, spent $28.40, biggest win was fleet-control's PR
0034 (drift detector), one thing to watch over the weekend:
courtiq's burn rate doubled" - so that the week ends with a
satisfying summary instead of just another scroll, and I get a
single artifact worth screenshotting to a friend.

## Why now (four lenses)

### Product Owner
0033's "Last 24 hours" card is the morning ritual; the digest
(0012) is the deep-dive at `/digest`. There is no glanceable
WEEKLY surface on the home page - the operator has to navigate
to `/digest` and scroll. A `fridayWrap(db, now)` helper that
reuses 0012's `weeklyDigest()` AS its data layer but renders a
COMPACT card (4-stat grid + 1 win + 1 watch-item) on the home
page ONLY on Fridays gives the operator a weekly ritual to
match the daily one. Pure composition - no new ingest, no new
schema. The card hides itself Saturday through Thursday so it
doesn't become visual noise. The diurnal/weekly pair (0033 +
0037) becomes a complete ritual loop: every morning recap,
every Friday wrap.

### Stakeholder
Widens the moat on `portal` and retention - specifically the
weekly-rhythm retention axis that 0026's streak heatmap and
0012's digest both gesture at but neither nails on the home
page. The cross-fleet courtiq lesson "the share-worthy
moment is the first 60 seconds, not the steady-state UX"
inverts here for retention: the share-worthy moment for an
EXISTING operator is the Friday afternoon "look what the
fleet shipped this week" screenshot. That's the artifact
that makes a friend ask "wait, what is fleet-control?" -
the same recruiting surface 0033's morning card hits in a
daily flavour, but tuned for the week-in-review post. Cheap
to ship (the digest already computes the data), high
retention payoff (a weekly ritual is what turns a tool into
a habit), and the only new code is the rendering + the
day-of-week gate.

### User (operator at Friday 4:50pm)
On Fridays, ABOVE the 0033 "Last 24 hours" card and the
0035 cost-per-PR summary line, a wider card appears:

```
This week                                       [tap for full digest]
  17 PRs shipped     $28.40 spent     2 anomalies     7 days active
  Biggest win: fleet-control · drift detector (0034) merged Tue
  Watch over weekend: courtiq burn rate 2.1x normal
```

The four-stat grid mirrors 0033's layout for visual
consistency. The "biggest win" picks the most-impactful merged
PR of the week using a simple score: `additions + deletions`
(per the existing PR shape), with ties broken by most recent
merge. The "watch over weekend" picks the single most worrying
open signal: any active drift (0034) first, else any active
correlation (0027), else the project with the steepest 7d
$/PR trend up (per 0035 if shipped), else `null` (omit the
line). The card is sticky-top on the home page Fridays
00:00-23:59 in the operator's local timezone. Tapping the
card opens `/digest`. Saturday-Thursday: the card is invisible,
no DOM element, no skeleton, no whitespace - byte-identical
home page to today.

### Growth
The screenshot worth sharing is "fleet shipped 17 PRs and
$28.40 spent this week, biggest win was the drift detector" -
shared Friday 5pm on Twitter, the day of the week with the
highest dwell time for tech tweets. This is a DISTINCT
artifact from 0033's morning card (daily recap, weekday
mornings) and 0035's $/PR summary (efficiency metric, always
visible) - the three together cover daily / value / weekly
retention loops without overlap. The "show me" pitch:
"every Friday at 5pm fleet-control shows you a one-card
recap of your week. Local-only, no SaaS, no LLM costs."

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/views.ts` exports `fridayWrap(db, now: Date,
      opts?: {tz?: string}): {window: {start: string, end:
      string, week_iso: string}, shipped_count: number,
      spent_usd: number, anomalies_count: number,
      active_days: number, biggest_win: {project_slug: string,
      pr_number: number, pr_title: string, ticket_id: string
      | null, merged_at: string, size_score: number} | null,
      watch_item: {kind: "drift" | "correlation" | "cost_trend",
      project_slug: string, message: string} | null,
      generated_at: string}`. The 7-day window ends at
      `now`. `shipped_count` is `merged_pr` rows in window
      across the fleet; `spent_usd` is the sum of
      `cost_rollup_day` over the 7 days; `anomalies_count`
      is rows in `anomaly` created in window (active OR
      dismissed); `active_days` is the count of distinct
      calendar dates in window with at least one merged PR.
      Per LESSONS § "node:sqlite's .all() needs `as unknown
      as T[]`", every row narrowing uses the double-cast.
      Per LESSONS § "julianday() drifts ~10us per timestamp",
      window arithmetic uses the strftime decomposition. Per
      LESSONS § "time-pinned tests must NOT derive seed
      timestamps from `new Date()`", every seed in the test
      anchors to the pinned `now`. Test: seed 17 PRs + $28.40
      cost + 2 anomalies + 7 active days, assert the four
      numbers exactly.
- [ ] `biggest_win` selection: among merged PRs in window
      across all projects, pick the one with the highest
      `additions + deletions` score (a NULL or zero score
      falls back to most-recent-merge order). When zero
      merged PRs in window, `biggest_win: null`. Test: seed 5
      merged PRs with known additions/deletions, assert the
      highest-scoring one is returned with its ticket-id
      resolved from the `ticket_commit_link` table (0018)
      when present.
- [ ] `watch_item` cascade evaluated in priority order,
      returning the FIRST non-null match:
      1. Any active `self_drift` anomaly (0034) from the
         current tick. Message: `"<slug> <metric> Nx normal"`.
      2. Any active `fleet_correlated` anomaly (0027).
         Message: `"<N> projects failing with <signature>"`.
      3. Any project whose 7d `dollars_per_pr` trend (0035
         if shipped, else null - gracefully skip this branch
         when 0035 hasn't shipped yet) is up >=50% vs prior
         7d. Message: `"<slug> burn rate <ratio>x normal"`.
      4. `null` (omit the watch line entirely).
      Test: seed each branch in isolation, assert the
      chosen watch item.
- [ ] `isFriday(now: Date, tz?: string)` helper: returns
      `true` when `now`'s day-of-week in the given timezone
      is Friday (using `Intl.DateTimeFormat` with `weekday:
      'short'` so no `tz` library is needed). Default tz is
      the operator's local (via
      `Intl.DateTimeFormat().resolvedOptions().timeZone`).
      Test: pin `now` to a known Friday UTC midnight + tz
      `America/Los_Angeles`, assert `false` (still Thursday
      in LA); pin to Friday noon UTC + tz `America/New_York`,
      assert `true`.
- [ ] `GET /api/fleet/friday-wrap` returns the shape from
      AC1 PLUS a top-level `visible: boolean` field set by
      `isFriday(now, tz)` - the route always responds 200
      so the SPA can pre-fetch on any day, but the SPA only
      renders when `visible: true`. Requires `read` scope.
      Accepts an optional `?tz=<iana>` param so the test can
      pin the timezone; falls back to the server's local tz.
      Test: hit without auth -> 401; with `read` on a
      non-Friday -> 200 with `visible: false` and `null`
      stats; on a Friday -> 200 with `visible: true` and
      populated stats.
- [ ] Caching: the route response sets
      `Cache-Control: max-age=600` (10 min - the wrap data
      changes slowly) and the handler memoises by
      `(week_iso, day_of_week)` in a module-level Map. Per
      LESSONS § "in-process dedup sets need an explicit reset
      hook for tests", expose `_resetFridayWrapCacheForTests()`
      AND `_getFridayWrapCacheBuildsForTests()` per LESSONS §
      "expose a build counter for cache-hit tests, not a
      fetcher swap". Test: two calls within 10min on the
      same day assert the build counter increments once;
      advance to a new ISO week, assert another increment.
- [ ] `web/app.js` renders the Friday-wrap card on the home
      page ONLY when the API response has `visible: true`.
      The card sits ABOVE the 0033 yesterday-glance card
      (and above the 0035 cost-per-PR summary if shipped).
      Layout: title "This week" + four inline stats
      (shipped, spent, anomalies, active_days) + the
      biggest-win line + the watch-item line (omitted when
      `watch_item: null`). On non-Fridays the card is NOT
      in the DOM at all (no skeleton, no whitespace - the
      home page is byte-identical to a pre-0037 render).
      Per LESSONS § "defence-in-depth secret redaction at
      the renderer boundary", the biggest-win PR title and
      the watch-item message pass through `redactSecrets`
      before insertion. The container has
      `data-testid="friday-wrap"` for stable phone-test
      hooks. Tapping anywhere on the card navigates to
      `/digest`. Test: stub `visible: true`, assert the
      DOM contains the testid and the expected stats;
      stub `visible: false`, assert the testid is absent.
- [ ] Mobile: at 375px viewport the four stats stack 2x2
      (matching the 0033 morning card's layout for visual
      consistency) and the win/watch lines wrap cleanly,
      no horizontal scroll (per 0011 conventions). At
      >=600px the stats live in one row. Test: assert via
      the existing mobile-portal text-level CSS contract
      at both widths.
- [ ] Quiet-hours integration: when 0030's
      `quietHoursActive` is `true` (e.g. operator browsing
      after midnight on Saturday), the Friday-wrap is NOT
      demoted (it's a pull surface, not a push) BUT the
      watch-item line is omitted on Fridays where every
      candidate watch-item kind is `band_shift_amber` or
      below per 0030's gating - critical kinds
      (drift, correlation) are never suppressed. Test:
      stub quiet hours active + an amber-only watch
      candidate, assert the watch line is omitted; stub
      same + a drift watch candidate, assert the line is
      present.
- [ ] Performance: `fridayWrap(db, now)` against a fleet
      of 10 projects with 90 days of telemetry completes
      in under 50ms. The HTTP route end-to-end (cache miss)
      completes in under 120ms. Per LESSONS § "in-process
      startServer() tests need an empty-roots config +
      run-row seeds", the server-boot tests plant a tmp
      `fleet-control.config.json` in cwd and restore on
      cleanup. Test: seed the dataset, time both, assert
      thresholds (skip if `process.env.PERF !== "1"`).
- [ ] No new runtime deps. `tsc --noEmit` clean. No
      shell-string composition. No JSON-shape break to
      any existing `/api/...` route - the new
      `/api/fleet/friday-wrap` is net-new; the home payload
      is unchanged (the card fetches the new route on
      render, NOT inlined). No schema migration - composes
      existing `pr`, `cost_rollup_day`, `anomaly`,
      `ticket_commit_link`, and the existing
      `weeklyDigest` data layer.

## Out of scope

- A configurable "wrap day" (Monday wrap, Sunday wrap).
  v1 is Friday-only - the weekly close-of-business
  ritual is fundamentally Friday for the operator
  persona. A configurable surface adds a knob with no
  obvious user.
- A Friday-NIGHT push notification ("your fleet shipped
  X this week"). The card is a pull surface only;
  push lives in 0009 ntfy and would re-fire the same
  morning-card debate. A clean follow-up if asked.
- A LIFETIME wrap (year-to-date, all-time). The leaderboard
  (0014) covers cumulative; this card is week-scoped only.
- Operator-customisable "biggest win" scoring (weight by
  $-saved, by file-count touched, etc.). v1 ships
  `additions + deletions` as a single deterministic score.
- A multi-week trend within the card (sparkline of weekly
  PRs over the last 4 weeks). The digest covers trend;
  this card is single-week.
- LLM-authored "what to celebrate" summaries. The biggest-
  win line picks deterministically from existing data; an
  LLM-narration surface adds runtime cost and the same
  operator-trust problem the deterministic verdicts in
  0033 solved.
- Custom date overrides ("show me the wrap for week of
  May 18"). The card is current-week only. The full
  digest (0012) already supports backward navigation if
  the operator wants a specific week.

## Engineering notes

- `src/views.ts` - new `fridayWrap(db, now, opts)` helper
  next to the existing `yesterdayGlance`. The four stats
  reuse the same SQL shapes as `yesterdayGlance` but with
  a 7-day window. The `biggest_win` query is `SELECT FROM
  pr JOIN project ... WHERE state='MERGED' AND
  fetched_at >= window.start ORDER BY (additions +
  deletions) DESC LIMIT 1` joined to `ticket_commit_link`
  (0018) for the ticket id. The `watch_item` cascade is
  three sub-queries with the existing `anomaly` table and
  - if 0035 ships first - the cost-per-pr helper.
  `isFriday` is a small helper using `Intl.DateTimeFormat`
  with `weekday: 'short'`. Per LESSONS § "node:sqlite's
  .all() needs `as unknown as T[]`", every row narrowing
  uses the double-cast. Per LESSONS § "julianday() drifts
  ~10us per timestamp", window arithmetic uses strftime.
- `src/server.ts` - one new route `GET
  /api/fleet/friday-wrap`. Reuse the existing `read` scope
  middleware. The 10-min memo cache is keyed by
  `(week_iso, day_of_week)` per LESSONS § "expose a build
  counter for cache-hit tests, not a fetcher swap" -
  expose `_resetFridayWrapCacheForTests()` and
  `_getFridayWrapCacheBuildsForTests()`. The `?tz=` param
  is whitelisted against `Intl.supportedValuesOf('timeZone')`
  before use - never composed into SQL (no shell-out either,
  per AGENTS.md).
- `web/app.js` - new `renderFridayWrap(data)` helper called
  from the existing home-page render path. Inserted ABOVE
  the yesterday-glance card; when `visible: false` the
  helper returns an empty string so no DOM element is
  emitted. The fetch happens unconditionally on home page
  load (the server's day-of-week gate is the single source
  of truth). Per LESSONS § "defence-in-depth secret
  redaction at the renderer boundary", every operator-
  visible string passes through `redactSecrets`.
- `web/style.css` - one selector group for the wrap card.
  Reuse the existing 0033 morning-card layout patterns to
  stay visually consistent. No new CSS variables.
- `tests/friday-wrap.test.ts` (new) - one `test(...)` per
  AC checkbox. Per LESSONS § "time-pinned tests must NOT
  derive seed timestamps from `new Date()`", every seed
  timestamp is anchored to the test's pinned `now`. The
  `isFriday` tests pin to known Fridays across multiple
  timezones. Per LESSONS § "in-process startServer()
  tests need an empty-roots config + run-row seeds", the
  server tests plant a tmp `fleet-control.config.json`
  in cwd and restore on cleanup.
- No new runtime deps. No schema migration - composes
  existing tables only. Pairs with 0012 (the digest is
  the deep-dive the card links to), 0014 (the
  leaderboard's existing window math is the reference
  for the 7d window), 0017 (the inbox sits BELOW the
  wrap on Fridays, ABOVE the wrap on non-Fridays
  because the wrap is invisible), 0018 (the ticket-id
  resolution for the biggest-win line), 0026 (the
  streak heatmap is the shape; this is the verdict),
  0027 + 0034 (the watch-item cascade reads from
  anomaly), 0030 (quiet-hours demote watch lines below
  critical), 0033 (the daily counterpart - together
  they form the daily/weekly retention loop), and 0035
  (the cost-per-PR trend is one branch of the watch-
  item cascade, gracefully skipped if 0035 hasn't
  shipped yet).

## Implementation log

(Appended by the implementation-dev agent during execution.)

- 2026-06-03 - branch `feat/0037-friday-wrap-weekly-card` opened
- 2026-06-03 - failing test added in `tests/friday-wrap.test.ts`
- 2026-06-03 - PR #88 opened, CI green (typecheck + validate)
- 2026-06-03 - PR #88 merged to main
