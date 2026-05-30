---
id: 0031
title: Per-project tool-mix sparkline - where this project's tokens actually went
status: groomed
priority: P2
area: observability
created: 2026-05-30
owner: gtm-innovation
---

## User story

As a fleet operator looking at one project's page because its burndown
(0028) just turned amber, I want a small stacked bar at the top of the
project page showing which tool calls (Edit / Read / Bash / Glob / Grep
/ Write / WebFetch / etc.) consumed THIS project's tokens over the
trailing 7 days, so that the answer to "where is my budget actually
going" is a glance question - "75% Bash, 12% Edit, 8% Read" - instead
of a dive through individual run traces.

## Why now (four lenses)

### Product Owner
0014 (cross-project leaderboard) answers "which project leans on
Bash"; 0028 (burndown) answers "is this project on track for the
budget." The gap between them is the per-project drilldown: when
the operator clicks into one project because the burndown is amber,
the natural next question is "what's eating the budget HERE." Today
the project page shows runs, PRs, jobs, anomalies - but no per-tool
attribution. Adding one stacked bar at the top of the project page
composes the two existing primitives into a single visual answer.
No new ingest, no new schema, one SQL view, one render path.

### Stakeholder
Widens the moat on `observability`. This is the strongest of the
three tickets in this batch on the moat axis: per-project tool-mix
attribution is structurally possible only because we ingest every
project's transcripts locally and store the `tool_use` /
`tool_result` events from day one. A SaaS dashboard sitting on top
of the Anthropic billing API knows the project's total $ but cannot
break it down by tool because the billing API does not surface
tool-name. Every operator who sees their first per-project
tool-mix sparkline has the "oh, that's why I'm paying for Bash"
realisation - and that is the moment that converts a curious
operator into a daily one.

### User (operator at 9am)
Project page gains a 280x36 px stacked horizontal bar near the top,
above the existing job cards. Each segment is one tool, coloured
from a fixed palette (Bash = amber, Edit = green, Read = blue, Glob
= violet, Grep = teal, Write = orange, WebFetch = magenta, others
collapsed into "other"). Width is the tool's share of trailing-7d
`tool_use` invocations for this project. A small inline legend
below: "Bash 41% - Edit 22% - Read 14% - other 23%." On phone the
bar shrinks to 200x28 and the legend wraps to two lines. On hover
(desktop) or tap (mobile) the segment shows a small tooltip with
absolute invocation count + seconds elapsed. Empty state (a
project with zero tool events in 7d, e.g. freshly registered)
renders "no tool activity this week" with no broken bar.

### Growth
"Each project tells me exactly which tools are eating my budget"
is the single sentence that the cost-conscious operator (the
acquisition target for fleet-control) wants to hear. The
screenshot of three project pages with three radically different
tool-mix bars - one almost all Bash, one half Edit + half Read,
one balanced - is a more concrete "show me" than any aggregate
dashboard, because it shows the SHAPE of how each agent works.
Paired with 0014's cross-project leaderboard, it gives the
operator both views (drill down + compare) without leaving the
portal.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/views.ts` exports
      `projectToolMix(db, projectId, now, days=7)` returning
      `{window: {start: string, end: string, days: number},
      tools: Array<{name: string, invocations: number,
      total_seconds: number, share: number}>, total_invocations:
      number}`. `share` is `invocations / total_invocations`
      (0..1). Tools are sorted by `invocations` descending, then
      grouped: the top 6 named tools survive verbatim; everything
      else collapses into a single `{name: "other", ...}` entry
      whose `invocations` is the sum of the tail. Per LESSONS §
      "node:sqlite's .all() needs `as unknown as T[]`", any new
      SQL row narrowing uses the double-cast pattern. Test: seed
      8 distinct tool names with descending counts for one
      project, assert the result has 7 entries (top 6 + "other")
      and shares sum to 1.0.
- [ ] `total_seconds` per tool reuses the same `strftime`-based
      paired (`tool_use` -> `tool_result`) computation from 0014
      (LESSONS § "`julianday()` drifts ~10us per timestamp;
      decompose with `strftime` for sub-ms diffs"). Test: seed
      two paired events 5.000s apart, assert
      `total_seconds` is 5.0 within 1e-6.
- [ ] `total_invocations === 0` (an empty project) returns
      `tools: []` and `total_invocations: 0` without dividing by
      zero anywhere. Test: empty `run_event` for the project,
      assert the empty shape and no NaN.
- [ ] `GET /api/projects/:slug/tool-mix?days=N` returns the
      shape. `days` clamps to `[1, 30]` with default 7 (matching
      the 0014 clamp pattern). Requires `read` scope. Test: hit
      without auth -> 401; with `read` and `days=999` -> 200 and
      `window.days === 30`.
- [ ] `getProject` (or the existing project-detail handler in
      `src/server.ts`) does NOT include the tool-mix in its
      payload - the project page lazily fetches it from the new
      route on render. This keeps the project-detail JSON shape
      additive-only (no breaking change) AND keeps the home-page
      `listProjects` payload small. Test: snapshot the
      project-detail payload, assert no `toolMix` key.
- [ ] `web/app.js` renders the stacked bar on the project page
      above the existing job cards. The bar is a single hand-
      rolled inline SVG (no charting lib), one `<rect>` per
      segment, fixed palette via existing CSS variables for the
      named tools and a neutral grey for `other`. Per LESSONS §
      "defence-in-depth secret redaction at the renderer
      boundary", the tool name and any operator-visible label
      pass through `redactSecrets` before insertion. The bar
      and its legend live in a container with
      `data-testid="project-tool-mix"` (per cross-fleet
      pattern: stable hooks for surfaces a future test will
      query). Test: stub the API with a 3-tool fixture, assert
      the SVG contains three `<rect>` elements with widths
      proportional to share.
- [ ] Tooltip: a hover (desktop) or tap (mobile) on a segment
      shows a small inline tooltip with
      "tool_name - {invocations} calls - {total_seconds.toFixed(1)}s".
      Tooltip lives inside the same container, no portal/
      overlay. Test: simulate a tap event on a segment, assert
      the tooltip text is present and contains the seeded
      numbers.
- [ ] Mobile: the bar shrinks to 200x28 at viewports <600px and
      the legend wraps to two lines without horizontal scroll
      at 375px (per 0011 conventions). Test: assert the
      viewport contract via the existing mobile-portal text-
      level CSS harness.
- [ ] Empty state: a project with `total_invocations === 0`
      renders no SVG and shows "no tool activity this week"
      beneath the project name. No broken layout, no NaN. Test:
      empty `run_event`, assert the empty-state DOM and absence
      of the SVG.
- [ ] Performance: `projectToolMix(db, projectId, now)` against
      one project with 5,000 `run_event` rows in the window
      completes in under 25ms; the new route end-to-end against
      the same data completes in under 75ms. Test: seed the
      dataset, time both, assert thresholds (skip if
      `process.env.PERF !== "1"`).
- [ ] No new runtime deps. `tsc --noEmit` clean. No new schema
      migration - reads existing `run_event` only. No JSON-
      shape break to any existing `/api/...` route - the
      `/api/projects/:slug/tool-mix` route is net-new and the
      project-detail payload is unchanged. No shell-string
      composition. The in-process `startServer()` tests follow
      LESSONS § "in-process startServer() tests need an empty-
      roots config + run-row seeds" - plant a tmp
      `fleet-control.config.json` in cwd with roots pointed at
      an empty tmpdir, snapshot/restore on cleanup.

## Out of scope

- A daily series ("show me how Bash share changed day-by-day
  this week"). v1 is a single trailing-window aggregate. A
  sparkline trend is a clean follow-up.
- Per-phase breakdown ("groom uses Bash twice as much as
  ship"). 0014 already has the cross-project per-phase
  heatmap; per-project per-phase is a follow-up if asked.
- Cost-weighted attribution (multiply each tool by its $
  share of the run). v1 uses invocation count + total
  seconds - cleaner narrative and lines up with the
  leaderboard's existing metrics. A `$` mode is a clean
  follow-up.
- An operator-configurable palette. v1 ships the fixed
  palette named in AC6.
- A "compare two projects' tool mix side-by-side" page. The
  leaderboard (0014) is already the fleet-wide compare; this
  ticket is the per-project drill-down only.
- Caching the result to a rollup table. The query is
  small-window; the AC10 perf budget covers it without a
  cache.
- LLM-generated "why is Bash dominant" hints. Operator
  reads, operator decides.

## Engineering notes

- `src/views.ts` - new `projectToolMix(db, projectId, now,
  days)` helper. Single SQL query that groups `run_event` by
  `tool_name` for the project + window, computing
  invocations and the strftime-based paired-duration total
  (mirror the 0014 helper's SQL shape). The top-6 + "other"
  collapse happens in JS post-query to keep the SQL
  straightforward. Per LESSONS § "node:sqlite's .all() needs
  `as unknown as T[]`", narrow with the double-cast.
- `src/server.ts` - one new route, reuse the existing `read`
  scope middleware. Clamp `days` to `[1, 30]` (matches the
  0014 pattern; tool-mix is a recent-window question, longer
  windows don't help the operator).
- `web/app.js` - new `renderToolMixBar(data)` helper called
  from the existing `project(slug)` render path. Pure DOM-
  string concatenation, one inline SVG with N `<rect>` per
  segment, one legend `<div>`. Tooltip is a sibling `<div>`
  positioned absolutely inside the container, shown on
  hover (desktop) or tap (mobile) - the existing CSS
  variable palette covers all colours. Per LESSONS §
  "defence-in-depth secret redaction at the renderer
  boundary", every operator-visible string (tool name,
  counts, seconds) passes through `redactSecrets` at the
  renderer boundary - the tool names are bounded by the
  Claude SDK but the defensive pass is the silent backstop.
- `web/style.css` - one selector group for the tool-mix
  container, segments, legend, and tooltip. Reuse existing
  `--bg`, `--panel`, plus named tool colours that ALREADY
  exist if any do; otherwise add `--tool-bash`,
  `--tool-edit`, `--tool-read`, `--tool-glob`,
  `--tool-grep`, `--tool-write`, `--tool-webfetch`,
  `--tool-other` to the palette. Additive only - no
  rename/repurpose of an existing variable (matches the
  0011 discipline).
- `tests/tool_mix.test.ts` (new) - unit tests against
  `projectToolMix` (one per AC1/AC2/AC3), HTTP tests
  against the new route (per AC4/AC5), SPA tests against
  the renderer (per AC6/AC7/AC8/AC9). Per LESSONS §
  "time-pinned tests must NOT derive seed timestamps from
  `new Date()`", every seed timestamp is anchored to the
  test's pinned `now` rather than the wall clock - so the
  test does not become a time-bomb in 4 weeks. Per
  LESSONS § "in-process startServer() tests need an empty-
  roots config + run-row seeds", the server-boot tests
  plant a tmp config in cwd and restore on cleanup.
- No new runtime deps. Pairs with 0014 (the leaderboard is
  the cross-project compare surface - tool-mix is the per-
  project drill-down; both share the same paired-duration
  SQL shape), 0028 (the project page's burndown card -
  the tool-mix bar sits directly above it so the operator
  can read "amber budget" and "75% Bash" in one glance),
  and 0017 (the inbox kind `run_failed` could in a
  follow-up link directly to the tool-mix bar with the
  failing tool highlighted).

## Implementation log

(Appended by the implementation-dev agent during execution.)
