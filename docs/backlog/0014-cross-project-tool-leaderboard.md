---
id: 0014
title: Cross-project tool-call leaderboard
status: groomed
priority: P1
area: observability
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator running 3-7 projects, I want a single page that
ranks tool calls across the whole fleet — which tools cost the most
time, which projects lean on which tools, where the error rates spike —
so that I can see at a glance "courtiq's groom is spending 40% of its
time on Bash, while almanac's ship is dominated by Edit" without
clicking into individual run traces for each project.

## Why now (four lenses)

### Product Owner
The portal today is project-shaped: every page roots in one slug. The
operator can see one run's tool timeline, one project's runs, one
project's cost. But the most valuable insight from running multiple
agents is the comparison — and the data is already in the database
(`run_event` table). One new view, one query, one route. No new ingest,
no new schema. The smallest possible feature that creates a meaningfully
new perspective on existing data.

### Stakeholder
This is the strongest moat-deepening surface in the backlog. A SaaS
agent dashboard could replicate "live tool stream" or "per-project
cost" with effort, but none of them have access to *every* agent's
tool-call history across *every* one of an operator's repos. The
cross-project leaderboard is structurally only possible because we run
locally, ingest from every repo on disk, and own the whole telemetry
surface. Once an operator gets used to seeing "tool X is 3x more
expensive on project Y than project Z", they will not go back to a
fragmented dashboard.

### User (operator at 9am, looking at the portal)
New top-nav link "Fleet · Compare". Renders a single page: top section
is a tool leaderboard (tool name | total invocations | total seconds
elapsed | error rate | top 3 projects using it), middle section is a
project leaderboard (project | top tool | tool diversity score |
average tools per run), bottom section is a side-by-side cost-by-phase
heatmap (project × phase). All values trail the last 14 days. Loads in
under 200ms on a fleet of 7 projects with ~5k events. Works on the
phone with one column stacks.

### Growth
"Show me the screenshot" — this is the second-most-shareable view after
the snapshot (0013). It demonstrates instantly that fleet-control sees
across projects, which is the property nothing else can replicate
without local access to every repo. The static screenshot tells the
story even before someone clicks anything.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/views.ts` exports `fleetLeaderboard(db, opts?)` returning:
      ```ts
      {
        window: { start: string, end: string, days: number },
        tools: Array<{
          name: string,
          invocations: number,
          total_seconds: number,
          error_rate: number,        // 0..1
          top_projects: Array<{ slug: string, invocations: number }>
        }>,
        projects: Array<{
          slug: string, name: string,
          top_tool: string | null,
          tool_diversity: number,    // distinct tool count
          avg_tools_per_run: number,
          runs_in_window: number
        }>,
        heatmap: Array<{
          slug: string,
          by_phase: { ship: number, groom: number, review: number, eng: number }
                                       // cost_usd per phase per project
        }>
      }
      ```
      Default window is the last 14 days. Pure SQL aggregation against
      `run` + `run_event` + `cost_rollup_day`. Test: seed two projects
      with three tool events each over 14 days, assert the tools array
      is sorted by invocations descending and top_projects per tool is
      sorted similarly.
- [ ] `total_seconds` for a tool is computed as the sum of
      `(tool_result.ts - tool_use.ts)` per matched pair within the
      window. Unmatched `tool_use` events (no result before the run's
      end) contribute zero. Test: seed two paired events 5s apart, one
      orphan, assert total_seconds = 5.
- [ ] `error_rate` is `count(tool_result where is_error=1) /
      count(tool_use within window)` for that tool. Test: 3 uses with 1
      errored result → 0.333..
- [ ] `tool_diversity` is the count of distinct `tool_name` values per
      project within the window. Test: seed Bash + Edit + Read → 3.
- [ ] `avg_tools_per_run` is total `tool_use` events / total runs in
      window for that project. Test: 3 runs with 6 tool_uses → 2.0.
- [ ] `GET /api/fleet/leaderboard?days=N` (default 14, max 90, min 1)
      returns the shape. Requires `read` scope. Test: hit with
      `days=999`, assert clamped to 90.
- [ ] `web/app.js` adds a new hash route `#/leaderboard` rendering all
      three sections. Single column on mobile (inherits from 0011), two
      column on desktop. Test: stub the API, assert each section has
      the expected number of rows after render.
- [ ] Empty-state: if `tools.length === 0` (a fleet with no ingested
      events yet), the page renders a friendly empty state pointing the
      operator at `fleetctl backfill`. Test: stub the API with empty
      arrays, assert the empty-state copy appears.
- [ ] Query performance: with a synthetic dataset of 50k `run_event`
      rows across 10 projects, the leaderboard query completes in under
      150ms on the dev machine. Test: insert 50k rows in a temp DB, time
      the call, assert < 150ms (or skip if `process.env.PERF !== "1"`
      to keep CI fast).
- [ ] No new runtime deps. No schema migration (queries existing
      tables). `tsc --noEmit` clean.

## Out of scope

- Filtering by phase or by date range in the UI. v1 is fixed-window,
  one page. Future ticket for time-travel.
- Tool input/output inspection on the leaderboard. The existing run
  detail page is the place for that.
- Cross-operator comparison (i.e. comparing my fleet to someone else's).
  Local-only by design.
- Caching the heatmap to disk. Pure SQL is fast enough at the data sizes
  one operator has.
- LLM-generated insights ("you should investigate X"). Operator reads
  the numbers, draws conclusions.

## Engineering notes

- `src/views.ts` — three new helpers `tools()`, `projects()`,
  `heatmap()` composed by `fleetLeaderboard()`. Keep each helper a
  single SQL statement with named parameters.
- `src/server.ts` — one route, no auth wrinkles (same pattern as
  `/api/fleet`).
- `web/app.js` — one new view function `renderLeaderboard(data)` and
  the hash-route hook.
- `web/style.css` — leaderboard table styles, heatmap cells. Lean on
  existing CSS variables.
- No new runtime deps. No schema migration. No shell-string
  composition (no shell at all in this module).
- Blocked-by: nothing. Cleanly orthogonal to everything else.
- Pairs with 0011 (mobile layout discipline) and 0013 (snapshot — the
  leaderboard view is one of the most valuable things to include in a
  shared snapshot once both ship).

## Implementation log

(Appended by the implementation-dev agent during execution.)
