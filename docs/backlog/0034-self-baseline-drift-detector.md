---
id: 0034
title: Self-baseline drift detector - flag when a project diverges from its OWN 14-day shape
status: in-progress
priority: P2
area: observability
created: 2026-06-01
owner: gtm-innovation
---

## User story

As a fleet operator whose `fleet-control` project usually spends 20%
of its tokens on Bash but suddenly spent 65% on Bash this morning
(because the loop got stuck in a heal cycle and kept re-running
`gh pr checks`), I want fleet-control to notice that THIS project's
tool-mix shape has diverged from its OWN 14-day baseline by more than
N standard deviations and surface one inbox row "fleet-control: Bash
share 3.2x normal since 02:11," so that I catch the silent-burn class
of failure - where nothing is "red" but the spend shape changed -
before the budget burndown turns amber 14 hours later.

## Why now (four lenses)

### Product Owner
The detectors today catch absolute outliers (0008 anomaly on duration
+ cost), cross-project failures (0027 correlation), and ABSOLUTE
budget thresholds (0021 autopause + 0028 burndown). None of them
catch relative drift: a project whose Bash share doubled, whose
Edit/Read ratio inverted, whose median run-cost moved up 50% without
crossing a fixed threshold. This class of failure is the most
expensive to catch late because it doesn't trip any alarm until the
weekly budget is half-eaten. A self-baseline detector that compares
the project's last 24h to its own trailing 14d on three shape
metrics (Bash share, Edit/Read ratio, median run cost) fires ONE
inbox row when any metric is >=2.5 sigma from baseline. Pure
composition of existing data (0014 tool counts, 0031 tool-mix shape,
`cost_rollup_day`). No new ingest, no new control surface, one SQL
view, one inbox kind, one detail page. Strict subtraction of "why is
my spend up?" diagnostic time.

### Stakeholder
Widens the moat on `observability`. This is the strongest moat-axis
ticket in this batch - structurally impossible for any tool that
does NOT have longitudinal per-project tool-event data. The
Anthropic billing API knows the TOTAL spend per project, not the
per-tool share. A SaaS dashboard sitting on top of GitHub Actions
sees PR success rate, not tool-mix shape. Only fleet-control, with
its locally-ingested `run_event` table going back 14+ days per
project, can compute "this project's Bash share moved 3 sigma from
its own baseline." Every operator who sees their first
self-baseline alert has the "oh, the AI dashboard wouldn't have
caught that" moment - exactly the kind of artifact that turns a
demo into a recommendation. Per the cross-fleet courtiq lesson "the
share-worthy moment is the structural impossibility for other
tools," this ticket goes after exactly that surface.

### User (operator at 9am)
A new inbox kind `self_drift` appears at the top of the inbox
(below `fleet_correlation` from 0027 but above `pr_review`) when
any project has a drifted metric. The row reads:

```
fleet-control: Bash share 3.2x normal since 02:11
  baseline 21% (14d) -> current 67% (24h)
  [investigate]  [dismiss]
```

Tapping "investigate" opens `/project/fleet-control/drift` showing
the three metrics side-by-side: trailing-14d baseline (mean +/- 1 sigma
band) overlaid with the last-24h actual, plus the three runs in the
last 24h that contributed most to the drift. The investigate page is
read-only - the operator decides whether to autopause the project
(0021's existing surface), kill the heal cycle, or accept the new
normal. Dismissing the inbox row hides it for 24h per the existing
inbox-dismissal pattern (0017); a new drift in the SAME metric
re-fires after the window closes per LESSONS § "re-fire-after-
dismiss needs an aging window."

### Growth
"It noticed my Bash share doubled and surfaced it before the budget
turned amber" is the single sentence that distinguishes
fleet-control from "an AI usage dashboard." The screenshot of the
investigate page - the trailing baseline as a soft grey band, the
last-24h shape as a sharp orange line crossing out of it - is the
most concrete proof of the local-only-telemetry moat. Paired with
0031's per-project tool-mix bar, the operator now has BOTH the
current shape and the drift-from-baseline view - two surfaces that
no competing tool can ship without operator-local data.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/drift.ts` (new) exports
      `detectProjectDrift(db, projectId, now, opts?): Array<{metric:
      string, baseline_mean: number, baseline_sigma: number,
      current: number, sigmas: number, first_seen_at: string,
      contributing_runs: string[]}>`. The three metrics computed:
      1. `bash_share` - share of `tool_use` invocations with
         `tool_name='Bash'` over total tool_use invocations.
      2. `edit_read_ratio` - count of `tool_name='Edit'` divided by
         `max(count of tool_name='Read', 1)`. Capped at 50 to avoid
         outlier blow-up.
      3. `median_run_cost_usd` - median of `run.cost_usd` for the
         project's runs in the window.
      Baseline is the trailing 14d (excluding the last 24h);
      "current" is the last 24h. Standard deviation is computed
      via the population formula over per-day values (14 data
      points for baseline). A metric is `drifted` if
      `|sigmas| >= 2.5` AND the baseline has at least 7 data points
      with non-zero variance. Per LESSONS § "anomaly tests need
      sigma > 0 in the fixture", every test fixture seeds a
      realistic spread (NOT a flat baseline) so the threshold is
      geometrically meaningful. Per LESSONS § "node:sqlite's
      .all() needs `as unknown as T[]`", any row narrowing uses
      the double-cast. Test: seed a 14-day baseline with
      Bash-share fluctuating 18-24% and a 24h window at 67%;
      assert one entry with `metric: 'bash_share'`, `sigmas` > 2.5,
      `current` ~= 0.67.
- [ ] Insufficient-data guard: when a project has fewer than 7 days
      of telemetry OR the baseline variance is below a noise floor
      (`baseline_sigma < 0.005` for `bash_share`, equivalent fixed
      floors for the other metrics), `detectProjectDrift` returns
      an EMPTY array for that project. Per LESSONS § "anomaly tests
      need sigma > 0 in the fixture, not just mean != value", the
      floor prevents "any deviation is 1000 sigma" when the
      baseline is flat. Test: seed a project with 5 days of data,
      assert the empty return; seed a project with 14 days of
      perfectly flat 0.20 Bash share, assert the empty return.
- [ ] `contributing_runs` is the top 3 `run.id` values (descending
      by contribution) for the drifted metric. For `bash_share`,
      contribution is the run's Bash-invocation count. For
      `edit_read_ratio`, contribution is the run's Edit count
      minus its Read count. For `median_run_cost_usd`,
      contribution is the run's cost in dollars. Test: seed 5
      runs with known shapes, assert the three highest-contribution
      run ids are returned in order.
- [ ] Daemon hook: after each ingest tick, run
      `detectProjectDrift` for every active project and INSERT one
      `anomaly` row per NEW drift (matched by
      `(project_id, kind='self_drift', correlation_signature=
      <metric>)` and a 24h window). Re-detecting the SAME drifted
      metric in the same window does NOT insert a duplicate. Per
      LESSONS § "re-fire-after-dismiss needs an aging window, not
      a partial UNIQUE index", idempotency lives in the
      application via a `WHERE created_at >= now - 24h` lookup
      before INSERT - never a UNIQUE constraint. Test: run the
      hook twice in a row, assert exactly one anomaly row; dismiss
      it, advance 25h, run again with the same drift active,
      assert a fresh row.
- [ ] `GET /api/projects/:slug/drift` returns the current drift
      detail: `{detected: Array<...>, baseline_window: {start,
      end, days: 14}, current_window: {start, end, hours: 24},
      generated_at: string}`. Requires `read` scope. Test: hit
      without auth -> 401; with `read` -> 200 plus the shape.
- [ ] `fleetInbox` (0017) gains a new item kind `self_drift` for
      each active drift (sorted between `fleet_correlation` and
      `pr_review` in the existing priority cascade). Each row
      carries `payload: {metric, sigmas, baseline_mean, current}`
      so the SPA can render the headline without a second fetch.
      Test: seed one drift, assert it appears as the second-from-
      top inbox item (correlation kind first if present, drift
      second).
- [ ] Dismissal: the inbox's existing dismiss action accepts
      `kind='self_drift'`, inserts an `inbox_dismissal` row (per
      0017) for the `(project_slug, metric)` pair, and hides the
      row from the inbox until a fresh drift in the SAME metric
      is detected outside the 24h dismissal window. Per LESSONS §
      "re-fire-after-dismiss needs an aging window, not a partial
      UNIQUE index", the dismiss-then-re-fire path is tested
      end-to-end. Test: dismiss; assert the next inbox call omits
      it; seed a fresh drift 25h later, assert it reappears.
- [ ] `web/app.js` renders the `self_drift` inbox kind with the
      headline `"<slug>: <metric> Nx normal since HH:MM"` (where
      `N = current / baseline_mean` rounded to one decimal). The
      "investigate" action navigates to `/project/<slug>/drift`.
      The detail view renders three side-by-side rows (one per
      metric) - each row showing the baseline mean +/- 1-sigma band
      as a small inline SVG bar and the current value as an
      overlaid orange marker. Per LESSONS § "defence-in-depth
      secret redaction at the renderer boundary", all operator
      strings pass through `redactSecrets` before insertion. The
      detail container has `data-testid="project-drift"` per the
      cross-fleet pattern for stable hooks. Test: stub the API
      with one drifted metric, assert the SVG renders with the
      orange marker outside the grey band; stub with no drift,
      assert "no drift detected" empty state.
- [ ] Mobile: at 375px viewport the three metric rows stack
      single-column without horizontal scroll (per 0011
      conventions). Each row's inline SVG shrinks to 280x32 from
      its desktop 400x40. Test: assert via the existing mobile-
      portal text-level CSS contract.
- [ ] Performance: `detectProjectDrift(db, projectId, now)`
      against one project with 14 days x 30 runs/day x 200
      tool_events/run completes in under 60ms. The per-tick
      daemon hook (running detect across 10 projects) completes
      in under 600ms. Per LESSONS § "julianday() drifts ~10us per
      timestamp; decompose with strftime for sub-ms diffs", every
      window arithmetic uses the strftime decomposition. Test:
      seed the dataset, time both, assert thresholds (skip if
      `process.env.PERF !== "1"`).
- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-string
      composition. No JSON-shape break to any existing
      `/api/...` route - the new `/api/projects/:slug/drift`
      route is net-new; the inbox's new kind is additive (the
      SPA's existing switch must already tolerate unknown kinds
      per the 0027 ship pattern). No schema migration - reads
      existing `run_event`, `run`, and `anomaly` only. The
      `anomaly` row uses the existing `kind` column added by
      0027. Per LESSONS § "in-process startServer() tests need an
      empty-roots config + run-row seeds", the server-boot tests
      plant a tmp `fleet-control.config.json` in cwd and
      restore on cleanup. Per LESSONS § "time-pinned tests must
      NOT derive seed timestamps from `new Date()`", every seed
      timestamp is anchored to the test's pinned `now`.

## Out of scope

- Operator-configurable sigma threshold. v1 ships 2.5 sigma as a
  fixed constant. A knob is a clean follow-up once the false-
  positive rate is observed in production.
- Operator-configurable metrics list. v1 ships the three named
  metrics above. A "watch this custom metric" surface is a follow-
  up if asked.
- Auto-pausing projects on drift detection. The autopause (0021) is
  the only auto-control surface; drift is purely diagnostic. The
  operator decides whether to pause.
- LLM-authored "why is Bash share up" hints. The investigate page
  surfaces the three highest-contributing runs; operator reads
  the transcripts.
- Cross-project drift correlation ("Bash share is up in N
  projects at once"). That's the 0027 correlation surface; this
  ticket is per-project only.
- A drift history page ("show me every drift this project ever
  had"). Dismissed drift anomalies live in the `anomaly` table
  - a viewer is a follow-up.
- Sub-daily detection (drift since 1h ago). v1 is 24h vs 14d
  only. A 1h window is noisier than the value it adds.
- Push notifications when a drift fires. The ntfy bridge (0009)
  could be wired in a follow-up; v1 is the inbox surface only.

## Engineering notes

- `src/drift.ts` (new) - the detector. The metrics are computed in
  SQL where possible (counts via existing 0014 patterns, median
  via SQL window) and reduced to mean/sigma in JS for the 14
  baseline data points. Per LESSONS § "node:sqlite's .all() needs
  `as unknown as T[]`", any row narrowing uses the double-cast.
  Per LESSONS § "julianday() drifts ~10us per timestamp", window
  arithmetic uses the strftime decomposition rather than julianday.
  No I/O outside the passed-in `db` handle.
- `src/daemon.ts` - one new call to `detectProjectDrift` per
  project after the existing ingest pass + correlation hook. One
  INSERT loop with the application-level 24h idempotency lookup
  per LESSONS § "re-fire-after-dismiss needs an aging window, not
  a partial UNIQUE index."
- `src/inbox.ts` - one new sub-query branch for the `self_drift`
  kind (analogous to the 0027 `fleet_correlation` branch). Per
  LESSONS § "no backticks inside template-literal SQL strings",
  identifiers stay plain.
- `src/server.ts` - one new route `GET
  /api/projects/:slug/drift`. Reuse the existing slug capture
  pattern (single-segment slug per LESSONS § "route regex for
  owner/name slugs needs an embedded slash" - here we are NOT
  matching a repo identifier, just a project slug, so the
  existing `[\w-]+` capture is correct).
- `web/app.js` - new `renderDriftInboxRow(item)` hook plus the
  detail view at `/project/:slug/drift`. The detail view renders
  three inline SVG rows; each is a hand-rolled `<rect>` + `<rect>`
  + `<circle>` triple (band + filled mean line + current marker).
  Per LESSONS § "defence-in-depth secret redaction at the
  renderer boundary", every operator-visible string passes through
  `redactSecrets` at insertion.
- `web/style.css` - one selector group for the drift container
  and the inline SVG colours. Reuse the existing palette plus the
  0031 named tool colours - no new CSS variables.
- `tests/drift.test.ts` (new) - unit tests for `detectProjectDrift`
  (one per AC1/AC2/AC3), end-to-end tests for the daemon hook
  (per AC4), HTTP tests for the new route (per AC5), inbox-shape
  tests (per AC6/AC7), and SPA tests for the detail view (per
  AC8/AC9). Per LESSONS § "in-process startServer() tests need
  an empty-roots config + run-row seeds, not direct rollup
  inserts", the server tests plant a tmp `fleet-control.config.
  json` in cwd and restore on cleanup. Per LESSONS § "time-
  pinned tests must NOT derive seed timestamps from `new
  Date()`", every seed timestamp is anchored to the test's
  pinned `now`.
- No new runtime deps. No schema migration. Pairs with 0014
  (cross-project leaderboard surfaces absolute tool counts; this
  detector compares per-project relative shape), 0017 (inbox is
  the surface), 0021 (autopause is the only auto-control;
  detector is purely diagnostic), 0022 (band-shifts are absolute;
  drift is relative - together they cover the two failure modes),
  0027 (correlations are cross-project; drift is intra-project -
  they form a 2x2 with absolute/relative on one axis and
  per-project/fleet-wide on the other), 0028 (burndown shows
  budget on track; drift catches the shape change BEFORE
  burndown turns amber, which is the strongest "early warning"
  composition in the backlog), 0030 (quiet hours demote
  non-critical drift inbox rows overnight - the SAME pattern as
  0033's verdict demotion), and 0031 (per-project tool-mix bar
  is the absolute current shape; drift is the relative-to-self
  view - together they answer "what is this project's shape AND
  how unusual is it").

## Implementation log

(Appended by the implementation-dev agent during execution.)

- 2026-06-01 - branch `feat/0034-self-baseline-drift-detector` opened
