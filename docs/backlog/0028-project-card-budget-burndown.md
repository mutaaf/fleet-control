---
id: 0028
title: Project card shows month-to-date budget burndown with projection line
status: in-progress
priority: P2
area: observability
created: 2026-05-28
owner: gtm-innovation
---

## User story

As a fleet operator who set a `MAX_DAILY_USD` budget on each project
and got the soft autopause (0021) but still wants to see the trend
before the cap blows, I want each project card to carry a small
inline chart of month-to-date cumulative spend versus the daily-cap-
times-days line, with a dashed projection line to month-end, so that
"is this project on track to spend $200 this month or $400?" is a
glance question instead of a calculator question.

## Why now (four lenses)

### Product Owner
0021 ships the *enforcement* (autopause when the daily cap is
breached). 0005 ships the *forecast* (30-day cost projection).
Neither answers the operator's daily question: "given how much
this project has cost so far this month, is it going to overshoot
my mental cap?" - which is a chart, not a number. A small inline
burndown on the project card composes the two existing primitives
into one visual answer. No new pricing logic, no new schema, just
a render path.

### Stakeholder
Widens the moat on `observability`. The forecast (0005) and the
autopause (0021) are already moat features - the chart is the
visible *expression* of those features. Every prospective operator
who looks at the screenshot understands in one second that this
tool quantifies the cost tail the way no SaaS dashboard with
opaque LLM bills can. The burndown also reduces the operator's
mental load of "am I about to blow the budget" - which is the
single most-asked question about autonomous agents in public
discourse right now.

### User (operator at 9am)
Each project card grows a 60x32 px inline SVG sparkline-style
chart. The X axis is "day of month" (1 to today); two series:
* Solid line: cumulative MTD spend in $.
* Dashed reference: `MAX_DAILY_USD * day_of_month` (the "if you
  spent exactly the cap every day" line).
* A short projected segment from today to month-end based on the
  trailing 7-day avg.
Final dot is coloured: green if MTD < cap-line, amber if within
20% of cap-line, red if over. A small label below: "$23.50 of
$60.00 cap MTD". On phone, the chart shrinks to 40x24 but stays
legible.

### Growth
"Each card shows you whether the project is on track for the
budget" is the single most concrete cost-control sentence the
tool can ship. The screenshot of seven cards with seven different
burndown shapes (one red, two amber, four green) is a more
honest "show me" than any single big-number dashboard.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/views.ts` exports `projectBurndown(db, projectId, now)`
      returning `{days: Array<{day_of_month: number,
      cumulative_usd: number}>, cap_per_day_usd: number,
      projected_eom_usd: number, cap_eom_usd: number, band:
      "green"|"amber"|"red"}`. The `days` array covers day 1 of
      the current local month through today inclusive. Test:
      hand-rolled fixture with 10 days of $1/day spend and a $2
      cap, assert `cumulative_usd[9] === 10` and
      `cap_per_day_usd === 2`.
- [ ] Cumulative spend is derived from `cost_rollup_day` via SQL
      `SUM(usd) OVER (ORDER BY day)`. Per LESSONS § "in-process
      startServer tests need an empty-roots config + run-row
      seeds, not direct rollup inserts", tests seed `run` rows
      and let `recomputeRollups()` derive the rollup. Test: seed
      runs across 5 days totalling $1 each, assert cumulative
      series `[1, 2, 3, 4, 5]`.
- [ ] Projection: `projected_eom_usd = cumulative_today_usd +
      (trailing_7_day_avg_usd * days_remaining_in_month)`. If
      fewer than 7 days of data, use the available average.
      Test: seed 10 days of $2/day in a 30-day month, assert
      `projected_eom_usd === 60` (20 + 2 * 20).
- [ ] Band rules:
      * `red`: `cumulative_today_usd > cap_per_day_usd *
        day_of_month` (already over the linear cap line).
      * `amber`: not red, AND `projected_eom_usd >
        cap_eom_usd * 0.8` (within 20% of the month-end cap or
        over it).
      * `green`: otherwise.
      A project with no `MAX_DAILY_USD` set returns `band='green'`
      and the cap series is omitted (cap_per_day_usd === null,
      cap_eom_usd === null). Test: seed each band case, assert.
- [ ] `cap_per_day_usd` is read from the project's manifest via
      the same path the existing autopause (0021) uses; no new
      ingest call. NULL when unset. Test: seed a project without
      MAX_DAILY_USD, assert null and `band === 'green'`.
- [ ] `listProjects` adds `burndown: {projected_eom_usd: number,
      cap_eom_usd: number | null, band: string}` (summary only)
      to each project row so the card colour dot renders without
      a second fetch. The full series is fetched lazily on card
      tap via `GET /api/projects/:slug/burndown`. Test: snapshot
      the home payload, assert the summary fields appear and the
      `days` array does NOT (keeps the home payload small).
- [ ] `GET /api/projects/:slug/burndown` returns the full shape.
      Requires `read` scope. Test: hit without auth -> 401, with
      `read` -> 200 plus the shape.
- [ ] `web/app.js` renders the inline SVG sparkline on each
      project card. The SVG is hand-rolled (no charting lib);
      width/height attributes scale via CSS for the mobile
      shrink. The dashed cap line uses
      `stroke-dasharray="2,2"`; the projected segment uses
      `stroke-dasharray="4,2"` and renders only when
      `projected_eom_usd` is known. Per LESSONS § "defence-in-
      depth secret redaction at the renderer boundary", any
      project-name strings rendered alongside the chart pass
      through `redactSecrets`. Test: stub each band, assert the
      DOM shape and class.
- [ ] Mobile: chart shrinks to 40x24 on viewports <600px and
      remains legible (per 0011 conventions); no horizontal
      scroll at 375px. Test: assert the viewport contract.
- [ ] Empty-state: a project with zero `cost_rollup_day` rows
      this month (e.g. freshly registered) renders no chart and
      shows "no spend this month" beneath the project name. No
      broken layout, no NaN. Test: empty `run` table for a
      project, assert the empty-state DOM.
- [ ] Performance: `projectBurndown` against a project with 31
      days of rollup data completes in under 10ms;
      `listProjects` for a fleet of 10 completes in under 100ms
      including the burndown summary. Test: time both, assert
      thresholds (skip if `process.env.PERF !== "1"`).
- [ ] No new runtime deps. `tsc --noEmit` clean. No new schema
      migration - reads existing `cost_rollup_day` and the
      manifest. No JSON-shape break to any existing
      `/api/...` route - the `burndown` field on
      `listProjects` is additive; the new
      `/api/projects/:slug/burndown` is net-new. Use the
      `as unknown as RowT[]` cast pattern.

## Out of scope

- Per-week or per-quarter budget views. v1 is the calendar
  month only; weekly is a clean follow-up.
- A "set budget from the portal" action. Budgets are set via
  the existing CLI / manifest path (0021 ships the seam).
- Forecast confidence bands. The projection is a single point
  estimate; a future ticket could add upper/lower bounds from
  variance.
- Multi-currency display. USD only (matches `cost_rollup_day`
  and the rest of the cost stack).
- Cross-project budget aggregation (a fleet-wide MTD vs total
  cap). Useful follow-up, not v1.
- Auto-tightening the cap when MTD trends high. The autopause
  (0021) is the only auto-control surface for cost; this
  ticket is purely visualisation.

## Engineering notes

- `src/views.ts` - new `projectBurndown(db, projectId, now)`
  helper. Single SQL query with a windowed `SUM(usd) OVER
  (ORDER BY day)` against `cost_rollup_day` filtered to the
  current local month. Use the `as unknown as RowT[]` cast
  per LESSONS § "node:sqlite's .all() needs as unknown as
  T[]".
- `src/views.ts` - extend `listProjects` to compute the
  summary (projection + band) inline; share helpers with
  `projectBurndown` so the two paths produce identical
  values for the same project.
- `src/server.ts` - one new route, reuse the existing
  `read` scope middleware.
- `web/app.js` - new `renderBurndownSparkline(data)` helper
  emitting an inline SVG. Two polylines (cumulative,
  projected) plus a dashed cap reference; one circle for
  the today-dot. Reuse existing CSS variable colours for
  the bands. Pure DOM-string concatenation - no SVG
  library.
- `web/style.css` - one selector group for the sparkline
  container and band colours.
- `tests/burndown.test.ts` (new) - unit tests against
  `projectBurndown` with hand-seeded `run` rows (NOT
  direct rollup inserts) per LESSONS § "depends on
  cost_rollup_day MUST seed through run rows". HTTP test
  for the new route; SPA test for the band classes.
- The local-month boundary uses the same TZ helper the
  cost rollups already use - do NOT add a new TZ source.
- No new runtime deps. Pairs with 0021 (the autopause's
  amber chip already exists - the chart's red dot can
  link the operator to the resume action), 0005 (the
  forecast feeds the projection via the same trailing-
  avg helper), 0015 (the badge SVG can adopt the same
  band colour for a "budget-status" badge variant in a
  follow-up).

## Implementation log

- 2026-05-29 [implementation-dev]: status -> in-progress. Branch
  feat/0028-project-card-budget-burndown opened off main. Implementing
  `projectBurndown(db, projectId, now)` in src/views.ts, extending
  `listProjects` with the burndown summary, wiring
  `GET /api/projects/:slug/burndown` in src/server.ts, and rendering
  the inline SVG sparkline in web/app.js. Tests seed runs (not direct
  rollup inserts) per the LESSON; the AC8 SPA tests are text-level
  over web/app.js and web/style.css.
