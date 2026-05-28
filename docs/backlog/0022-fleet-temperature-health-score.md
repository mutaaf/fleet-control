---
id: 0022
title: Fleet temperature — single per-project health score on the home page
status: in-progress
priority: P1
area: observability
created: 2026-05-27
owner: gtm-innovation
---

## User story

As a fleet operator landing on the portal home page on my phone at 9am,
I want each project card to carry one 0-100 health number — a coloured
dot plus a tooltip explaining its composition — so that "which one
needs me first?" is answered before I scroll, instead of having me read
five sparklines and three timestamps to triangulate the same thing.

## Why now (four lenses)

### Product Owner
The home page today is *informationally* rich (telemetry strip,
prs_merged, last run outcome, cost trend) but *decisionally* poor —
the operator's eye has to integrate four signals to answer one
question. A single score, derived from those same signals, doesn't add
data; it subtracts cognitive work. That is the right shape of a v1.

### Stakeholder
Widens the moat on `observability`. The score is only meaningful
because we own every project's transcripts, runs, anomalies, PR
states, and cost rollup — a SaaS dashboard that touches only one of
those dimensions can't compose this number honestly. The composition
formula is documented in the tooltip, so operators (and the autonomous
reviewer) can audit it.

### User (operator at 9am)
Each project card grows a coloured dot to the left of the slug:
`green` (≥80), `amber` (50-79), `red` (<50), `grey` (no data — new
project or paused). Tapping the dot opens an accessible tooltip /
popover listing the four sub-scores. Home page sorts by ascending
score (worst first) when a query param `?sort=health` is set; default
order unchanged so this ticket doesn't churn the existing layout for
anyone who has the URL bookmarked.

### Growth
The "fleet at a glance" screenshot a prospective operator will share
is exactly this: seven cards, six green, one amber, you know in a
second what's going on. It's the kind of UI moment that turns a README
GIF into a sales pitch.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/views.ts` exports `projectHealth(db, projectId, now)`
      returning `{score: number, band: "green"|"amber"|"red"|"grey",
      subs: {ship_success: number, anomaly: number, pr_age: number,
      cost_trajectory: number}, generated_at: string}`. Each sub-score
      is 0-100, weights are equal (25 each), the composite is the
      rounded mean. Test: hand-rolled fixture for each sub-score
      reaches its extreme; assert the composite rounds correctly.
- [ ] `ship_success` sub-score: over the last 20 non-smoke `run` rows
      with `phase='ship'`, fraction with `outcome='shipped'` times 100.
      Zero runs → returns `null` (which contributes to the `grey`
      band, NOT a 0). Test: seed 20 runs (15 shipped, 5 failed),
      assert 75.
- [ ] `anomaly` sub-score: 100 minus
      `min(100, 10 × count_of_open_anomalies_last_7d)`. An "open"
      anomaly is one with `dismissed_at IS NULL` from the existing
      `anomaly` table. Test: seed 3 open anomalies, assert 70.
- [ ] `pr_age` sub-score: derived from the oldest open agent PR's age
      in hours, mapped: 0-6h → 100, 6-24h → 80, 24-72h → 50,
      72h+ → 20, no open agent PR → 100 (healthy). The age is sourced
      from the `pr` row's `fetched_at`-anchored snapshot of GitHub's
      `createdAt` — see engineering notes for the schema change.
      Test: seed each band, assert the mapped value.
- [ ] `cost_trajectory` sub-score: 100 minus `min(100, 100 ×
      max(0, (last_7_day_avg - prior_7_day_avg) / max(prior_7_day_avg,
      0.01)))`. I.e. flat or down trajectory → 100, doubled spend →
      0. Sourced from `cost_rollup_day`. Test: seed two 7-day windows
      with the prior at $1/day and the recent at $2/day, assert 0
      (saturated). Seed flat $1/$1, assert 100.
- [ ] Schema migration: extend the `pr` table with a `gh_created_at`
      column (idempotent ALTER, NULL-tolerant — `docs/LESSONS.md`
      pattern for older DBs). Update `src/ingest/prs.ts` to include
      `createdAt` in the `gh pr list --json` field list and persist
      it. The fetched JSON shape adds one key; no breaking change to
      any `/api/...` route. Test: ingest a stub `gh` payload via the
      runner seam, assert the column populated.
- [ ] `listProjects` (in `src/views.ts`) adds `health: {score, band}`
      to each project row. The detailed `subs` and `generated_at` are
      NOT inlined here — they're fetched on tooltip open via
      `GET /api/projects/:slug/health` so the home payload stays
      small. Test: snapshot the home payload, assert the new field
      and absence of others.
- [ ] `GET /api/projects/:slug/health` returns the full
      `projectHealth` shape. Requires `read` scope. Test: hit without
      auth → 401, with `read` → 200 + the shape.
- [ ] Performance: `projectHealth` for a single project completes in
      under 20ms; `listProjects` for a fleet of 10 completes in under
      150ms. Use SQL-level aggregation (no per-row loops in JS).
      Test: seed 10 projects with full telemetry, time both, assert
      under thresholds (skip if `process.env.PERF !== "1"`).
- [ ] `web/app.js` renders a coloured dot prefix on each project card
      and wires the click-to-tooltip behaviour. Tooltip shows the
      four sub-scores and weights and a one-line definition each.
      Mobile: tap-toggle (no hover-only path). Per 0011 conventions —
      no horizontal scroll at 375px. Test: stub each band, assert the
      DOM dot class + tooltip content.
- [ ] `?sort=health` query param sorts the project grid ascending by
      `health.score`. Default ordering unchanged. Test: load the page
      with and without the param, assert the order matches.
- [ ] No new runtime deps. `tsc --noEmit` clean. No JSON-shape break
      to any existing `/api/...` route (the inline `health` summary is
      additive; the `gh_created_at` column is internal to the PR
      ingest path). Use the `as unknown as RowT[]` cast pattern.

## Out of scope

- A historical health-score sparkline. v1 is one current value; a
  rolling history table is a clean follow-up once the formula has
  settled in production.
- Per-project weight customisation. Equal-weights is the v1 contract;
  if operators want bespoke weights they can fork the helper.
- A "fleet-wide" composite (the mean of project scores). Easy add
  later but risks a misleading single number; v1 surfaces the worst
  project, which is the real action signal.
- Auto-creating an inbox item (0017) when a score drops a band. Clean
  follow-up; the inbox is a separate ticket.
- LLM-authored health explanations. The tooltip is deterministic.

## Engineering notes

- `src/views.ts` — `projectHealth(db, projectId, now)` plus the
  `listProjects` add. Use the `as unknown as RowT[]` cast per
  `docs/LESSONS.md` § `node:sqlite`'s `.all()` needs `as unknown as T[]`.
- `src/ingest/prs.ts` — add `createdAt` to the `--json` field list
  and the INSERT. Touch nothing else. Per AGENTS.md, `gh` is invoked
  via `execFileSync` already; argv stays an array.
- `src/db.ts` — append `ALTER TABLE pr ADD COLUMN gh_created_at TEXT`
  to the ALTERs block (idempotent — the try/catch around each
  statement makes duplicate columns a no-op).
- `src/server.ts` — one new route, reuse the existing scope
  middleware.
- `web/app.js` — `renderHealthDot(health)` helper plus a tooltip
  component (vanilla `<details>` with a custom marker, or a
  lightweight click-toggle on a `<button aria-expanded>` — keep
  keyboard-accessible). No new deps.
- `web/style.css` — three colour tokens for the bands (reuse the
  existing CSS variable palette).
- The sub-score formulas in the tooltip should match exactly what
  `projectHealth` computes — render them from the API response, not
  hardcode them in the SPA, so the docs stay live.
- No new runtime deps. Pairs with 0015 (the badge can adopt the same
  band colour for prospective-operator share-outs), 0017 (the inbox
  surfaces *what* to do; the health dot surfaces *who* needs
  attention — together they bound the morning ritual), and 0021 (a
  paused project renders as `grey` rather than `red`).

## Implementation log

- 2026-05-28 — picked up by implementation-dev. Branch
  `feat/0022-fleet-temperature`. Plan: failing tests first
  (`tests/health.test.ts` for the pure helper + ingest column, augment
  `tests/badge-route.test.ts`-style harness for the new
  `/api/projects/:slug/health` route, JSDOM-free DOM assertions for the
  SPA dot + tooltip). Then implement `projectHealth()` in `src/views.ts`,
  the `gh_created_at` ALTER + ingest field, the new route, and the
  vanilla SPA dot/tooltip. PERF tests gate on `process.env.PERF==="1"`
  per the ticket.
