---
id: 0008
title: Anomaly detection on run duration and cost
status: in-progress
priority: P2
area: observability
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator, I want a run that takes 5× the usual time or costs
3× the usual $ to surface as an anomaly in the portal, so that a degraded
loop doesn't silently waste budget for a day before I notice.

## Why now (four lenses)

### Product Owner
The portal has the data (`run` table + `runs.jsonl` cost overlay); it
just doesn't compare. A baseline + flag is one query + one badge.

### Stakeholder
Widens the moat on `observability`. Catches "the dev agent got stuck in a
tool-error loop" without the operator having to read transcripts.

### Operator
Sees a red `anomaly` badge on a run; clicks to see the candidate reason
(e.g. "no test gate output found", "22min on tool errors") and decides.

### Growth
"Detects degraded runs automatically" is a property worth showing.

## Acceptance criteria

- [ ] `src/anomaly.ts` (new) — `flagRun(db, run_id)` computes the
      (project, phase) baseline over the previous 14 days (mean + stddev
      of `duration_ms` and `cost_usd`) and flags the run if either is
      >3σ above the mean AND the baseline has at least 5 samples. Inserts
      a row per fired metric in a new `anomaly` table:
      `(id INTEGER PRIMARY KEY, run_id, kind TEXT, value REAL,
      baseline_mean REAL, baseline_stddev REAL, sample_count INTEGER,
      candidate_reason TEXT, created_at TEXT, UNIQUE(run_id, kind))`. The
      `kind` value is one of `duration` or `cost`.
- [ ] Returns `{flagged: false, reason: "insufficient_baseline"}` when
      sample_count < 5 — no row inserted. Test: 4 prior runs → no flag.
- [ ] `bin/fleetctl.ts backfill` calls `flagRun` for each newly-ingested
      run, after the cost rollup pass so cost data is current.
- [ ] `candidate_reason` is a deterministic heuristic, not ML. Scan the
      run's `run_event` rows (already ingested) and return the first
      matching string:
      - `"repeated tool errors"` if `>= 3` events have `is_error = 1`.
      - `"no test gate output"` if no `tool_use` event has `tool_name IN
        ('Bash')` AND no event mentions `tsc|test|validate` in
        `input_summary`.
      - `"transcript truncated"` if the run's last event is a `tool_use`
        with no matching `tool_result`.
      - Otherwise `null`. No transcript file I/O.
- [ ] `/api/projects/:slug/anomalies?limit=N` returns the recent flagged
      runs (default N=10, max 50). Shape:
      `{anomalies: [{run_id, phase, kind, value, baseline_mean,
      stddev_multiplier, candidate_reason, created_at}]}`.
      Requires `read` scope.
- [ ] `web/app.js` per-project card gains an "Anomalies (N)" pill linking
      to `#/p/<slug>?view=anomalies` when at least one anomaly exists in
      the trailing 24h. Pill is red if any anomaly is < 1h old, otherwise
      amber.
- [ ] `web/app.js` run detail page (`#/r/<id>`) shows an "Anomaly:
      <kind> <multiplier>σ above baseline — <candidate_reason>" badge
      when the run is flagged.
- [ ] `tests/anomaly.test.ts` covers, with one test scenario per box:
      - 14 days of runs at `duration_ms = 10000`, insert one at `60000`,
        assert one `duration` anomaly row written.
      - same baseline, insert one at `15000`, assert no row written.
      - 4 prior runs only, insert a 10× outlier, assert no row written
        and the helper returns `insufficient_baseline`.
      - seed 3 `is_error = 1` events on a run, assert
        `candidate_reason = "repeated tool errors"`.
      - re-running `flagRun` on the same run is idempotent — second call
        returns `{flagged: false, reason: "already_flagged"}` (UNIQUE
        constraint).
- [ ] `tsc --noEmit` clean. No new runtime deps. No shell-string
      composition (no shell at all in this module).

## Out of scope

- Anomaly *prediction*. Reactive flagging only.
- Auto-pause on anomaly. The operator decides.
- Tuning σ multipliers from the UI. Hardcoded to 3 in v1.

## Engineering notes

- `src/anomaly.ts` — pure SQL + small math. No new deps.
- `src/db.ts` — new `anomaly` table.
- `web/app.js` — small additive UI.
- Depends on enough runs to baseline; if data is thin, no flags (silent OK).

## Implementation log

- 2026-05-26 — implementation-dev: branched `feat/0008-anomaly-detection`
  from main. Status flipped to `in-progress`. Test scaffold lands first in
  `tests/anomaly.test.ts`, one node:test scenario per AC checkbox; the
  helper under test (`src/anomaly.ts`) and the new `anomaly` table follow,
  then the `bin/fleetctl.ts backfill` wire-up, the
  `/api/projects/:slug/anomalies` route, and the additive `web/app.js`
  pill + run-detail badge.
