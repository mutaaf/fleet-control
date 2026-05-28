---
id: 0026
title: Merge streak counter and 90-day calendar heatmap on portal home
status: in-progress
priority: P1
area: portal
created: 2026-05-28
owner: gtm-innovation
---

## User story

As a solo fleet operator who runs the autonomous agents to see real
work ship while I sleep, I want the portal home page to show a single
"47 days of green ships" streak counter and a 90-day calendar heatmap
of merge activity across all my projects, so that opening the portal
each morning carries the small dopamine hit of "the streak is alive"
- the same hook that keeps GitHub's contribution graph addictive,
but for ships my fleet did unattended.

## Why now (four lenses)

### Product Owner
The portal answers "what needs me?" (0017 inbox) and "who's healthy?"
(0022 dot) but it doesn't answer "is the fleet *working*?" - the
emotional question every operator asks before triage. A streak
counter + heatmap is one widget, deterministic from existing `run`
and `pr` rows, that turns the morning portal-open from a chore
("any disasters?") into a small win ("47 days, still going"). It is
strictly additive - no schema changes, no new ingest paths, no new
control surface.

### Stakeholder
Widens the moat on `portal` and retention. The single biggest
weakness of a local-only tool with no signup is "operator forgets
it exists" - there's no email, no notification, no SaaS push to
re-engage. The streak counter + heatmap is the cheapest retention
hook in the kit: every glance reinforces the habit. It also
re-uses telemetry that is already fully ingested - the moat
property is that only this tool has the data to draw the heatmap
without an external service.

### User (operator at 9am)
Above the inbox section on the home page, a single line:
"Fleet streak: 47 days - last red day 2026-04-11". Below that, a
GitHub-style 90-day heatmap (13 weeks x 7 days = 91 cells) where
each cell's intensity is the number of merged PRs that day across
the whole fleet. A cell with zero merges renders empty; a cell with
a `run.outcome='failure'` and no compensating merge renders red
(streak-breaker). Hover/tap a cell to see "2026-05-12: 4 PRs
merged across fleet-control, ghost-mode". Empty days don't break
the streak (only red days do); weekends are allowed to be empty.

### Growth
"My agents have shipped on a 47-day streak" is a strictly more
shareable sentence than "my agents shipped this week". The heatmap
itself is a screenshot worth posting - it's the contribution-graph
shape every developer immediately recognises, but applied to
autonomous work the operator didn't do themselves. Pairs with the
weekly digest (0012) and the demo fixture (0025) - the demo fleet
ships with a populated heatmap so the show-HN moment includes a
visible 30-day-streak by default.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/views.ts` exports `fleetStreak(db, now)` returning
      `{streak_days: number, last_red_day: string | null,
      heatmap: Array<{date: string, merged: number, failed: number,
      band: "empty"|"low"|"med"|"high"|"red"}>}` covering the last
      90 days (today inclusive). A day's `band` is `red` if any
      `run.outcome='failure'` (across all projects) AND zero
      `merged_pr` rows that day; else `high` (>=4), `med` (2-3),
      `low` (1), `empty` (0). Test: hand-rolled fixture for each
      band, assert the bucket.
- [ ] Streak definition: consecutive days back from today where the
      day's band is NOT `red`. An `empty` day (zero activity) does
      NOT break the streak - the operator's agents can take
      weekends off. Only an *unrecovered* failure breaks it. Test:
      seed (today: empty, -1: low, -2: empty, -3: red), assert
      `streak_days=3` and `last_red_day` is the seeded red day's
      date.
- [ ] Day boundary is the operator's local timezone (the same one
      the daily cost rollups already use - read from the existing
      config or `process.env.TZ` fallback). Cross-midnight runs
      attribute to the day they STARTED. Test: seed a run at
      2026-05-12 23:59 local, assert it counts toward May 12 not
      May 13.
- [ ] Merged PR count is sourced from the existing `pr` table
      where `state='MERGED'` and `merged_at` falls in the day. NO
      new ingest path - this reuses what 0019 already populates.
      Test: seed two merged PRs on 2026-05-12, assert
      `heatmap[for 2026-05-12].merged === 2`.
- [ ] Failure count is sourced from `run.outcome='failure'` AND
      no later `run.outcome='success'` exists for the same project
      that day (the same "unrecovered failure" definition the
      inbox's `run_failed` kind uses in 0017). Test: seed a
      failure at 10am and a success at 11am same project same day,
      assert that day's `failed === 0` (recovered).
- [ ] `GET /api/fleet/streak` returns the shape. Requires `read`
      scope. Test: hit without auth -> 401, with `read` -> 200
      plus the shape.
- [ ] `web/app.js` renders the streak line and heatmap above the
      existing inbox on home. Heatmap is 13 columns (weeks) x 7
      rows (days) of CSS-grid cells; each cell is a `<button>` for
      keyboard accessibility with `aria-label` carrying the date
      and counts. Tap/click toggles a tooltip; mobile: tap-toggle
      (no hover-only path), per 0011 conventions. Test: stub the
      API with a fixed payload, assert the grid is 91 cells with
      the right band classes, assert no horizontal scroll at
      375px viewport.
- [ ] Performance: `fleetStreak` against a fleet with 10 projects
      and 90 days of activity completes in under 50ms. Use SQL
      aggregation in a single query per band (no JS loops over
      runs). Test: seed the dataset, time the call, assert
      <50ms (skip if `process.env.PERF !== "1"`).
- [ ] Empty-state: a fresh DB with zero runs renders
      `streak_days: 0, last_red_day: null, heatmap: [...91 empty
      cells]` and the SPA shows "Fleet streak: starting today" -
      no error, no broken layout. Test: hit the route with an
      empty DB, assert the response and the rendered string.
- [ ] No new runtime deps. `tsc --noEmit` clean. No new schema
      migration - reads existing `run` and `pr` tables. No
      JSON-shape break to any existing `/api/...` route (the
      `/api/fleet/streak` route is net-new). Use the
      `as unknown as RowT[]` cast pattern.

## Out of scope

- Per-project streaks. v1 is the fleet-wide streak only - the
  whole point is the single-number morning glance. Per-project
  streaks would dilute that.
- Configurable streak rules (e.g. "weekends don't count" toggles).
  The "empty days don't break streak, red days do" rule is the v1
  contract; a power-user knob is a follow-up.
- Long-term storage of streaks beyond 90 days. The heatmap is a
  fixed 90-day window; if the operator wants historical streaks
  they read `run.outcome` directly.
- Streak-broken notifications via ntfy (0009). The portal surface
  is the v1 - operator sees the red cell on next visit. A push
  notification is a separate ticket.
- Streak leaderboards across operators. The whole tool is local;
  there's no "operators" plural to compare.

## Engineering notes

- `src/views.ts` - new `fleetStreak(db, now)` helper. Pure SQL
  aggregation: one `GROUP BY date(ts)` for the heatmap, then one
  JS loop over the resulting 90 rows to compute the streak walking
  backwards. Use the `as unknown as RowT[]` cast per LESSONS §
  "node:sqlite's .all() needs as unknown as T[]".
- `src/server.ts` - one new route, reuse the existing `read` scope
  middleware.
- `web/app.js` - new `renderStreak(data)` plus `renderHeatmap(cells)`
  helpers. CSS grid for the 13x7 layout; one cell per day. Reuse
  the existing band colour tokens from 0022 where possible (green
  family for `low`/`med`/`high`, red for `red`, neutral for
  `empty`).
- `web/style.css` - one selector group for heatmap cells; reuse
  the existing CSS variable palette. Cell size: 12px on desktop,
  14px on mobile (touch target).
- Tests live in `tests/streak.test.ts` (new). For the in-process
  startServer boot, follow LESSONS § "in-process startServer()
  tests need an empty-roots config + run-row seeds, not direct
  rollup inserts" - seed `run` and `pr` rows directly, not any
  cached rollup.
- No new runtime deps. Pairs with 0017 (inbox sits below the
  heatmap), 0022 (health dot per project; streak is the fleet
  composite), 0012 (weekly digest can quote the current streak),
  and 0025 (the demo fixture seeds a populated heatmap by
  default).

## Implementation log

- 2026-05-28 — picked up by implementation-dev. Branch
  `feat/0026-merge-streak-calendar-heatmap`. Tests-first per AC box:
  `tests/streak.test.ts` with one scenario per checkbox (band buckets,
  streak walk, day-boundary attribution, merged-PR count, unrecovered
  failure, route + scope, SPA renderer, perf, empty-state, deps + JSON
  shape). Implementation: new `fleetStreak(db, opts)` in `src/views.ts`
  (one `GROUP BY date(started_at)` over `run`, one `GROUP BY
  date(merged_at)` over `pr`, one JS walk for the streak), new
  `GET /api/fleet/streak` route in `src/server.ts` behind the existing
  `read` scope, new `renderStreak(data)` + `renderHeatmap(cells)` in
  `web/app.js`, one `.heatmap` selector group in `web/style.css`
  reusing `--good`/`--warn`/`--bad`/`--faint` tokens. No new runtime
  deps, no schema migration.
