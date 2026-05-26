---
id: 0008
title: Anomaly detection on run duration and cost
status: groomed
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
      of `duration_ms` and `total_cost_usd`) and flags the run if either
      is >3σ above the mean. Inserts a row in a new `anomaly` table:
      `(run_id, kind, value, baseline_mean, baseline_stddev, candidate_reason)`.
- [ ] `bin/fleetctl.ts backfill` calls `flagRun` for each newly-ingested
      run.
- [ ] `candidate_reason` is a best-effort heuristic, not ML: scan the
      transcript tail for repeated tool errors, missing test output, or
      truncation. Top-3 phrases → comma-separated string. If nothing
      stands out, returns `null`.
- [ ] `/api/projects/:slug/anomalies?limit=N` returns the recent flagged
      runs.
- [ ] `web/app.js` per-project card gains an "Anomalies (3)" link when
      `anomaly_count_24h > 0`.
- [ ] `tests/anomaly.test.ts` — seed 14 days of runs averaging
      `duration_ms = 10000`, insert one at `60000`, assert it flags; one
      at `15000`, assert it doesn't.

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

(Appended by the implementation-dev agent during execution.)
