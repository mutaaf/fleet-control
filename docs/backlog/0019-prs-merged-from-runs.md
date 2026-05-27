---
id: 0019
title: prs_merged count reads from runs not control_audit
status: shipped
priority: P1
area: portal
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator looking at the portal headline strip, I want the "PRs
merged" count to reflect actually-merged PRs, not just PRs I clicked
"Approve & publish" on in the portal, so the number matches what GitHub
shows.

## Why now (four lenses)

### Product Owner
Today every project reads 0 PRs merged in the portal even though 22 +
36 = 58 PRs have actually merged across the two self-hosted projects in
the last 18h. The metric is wrong, and the wrong number is worse than no
number — it makes the loop look broken when it's working.

### Stakeholder
Widens the moat on `portal` honesty. Misleading metrics erode trust in
the portal as a glance surface.

### Operator
Glance at "agent-fleet · 22 PRs merged · $75" matches what GitHub shows.
Today it says "0 PRs · $75" and the operator has to leave the portal to
check.

### Growth
The screenshot of the portal showing real merge counts is the demo. The
current "0" everywhere undermines every other number on the page.

## Root cause

`src/digest.ts#prActionsByProject` (and equivalents in `views.ts`) counts
rows in `control_audit` with `action='pr-merge'`. The control_audit row
is only written when the operator clicks the "Approve & publish" button
in the portal, which calls `doAction(action='pr-merge')`. Agent PRs that
merge via `gh pr merge --auto --squash` (the normal path) never write a
control_audit row → never get counted.

## Acceptance criteria

- [ ] `src/views.ts` and `src/digest.ts` count merged PRs from the `run`
      table: `SELECT COUNT(DISTINCT pr_number) FROM run WHERE
      project_id=? AND outcome='shipped' AND pr_number IS NOT NULL`
      (scoped to the relevant time window for digest).
- [ ] The home grid card and the headline strip both update to use this
      number. `web/app.js` references stay the same — only the
      server-side source changes.
- [ ] The audit-based count (operator-driven merges) stays available as
      `prs_merged_via_portal` on the same JSON object, so a future ticket
      can split "via portal" vs "auto-merged" if useful.
- [ ] `tests/prs-merged.test.ts` seeds 3 shipped runs with pr_number
      {10,11,12} for one project and 0 control_audit rows; asserts
      `prs_merged: 3`. Adds one duplicate run for pr_number 10 and
      asserts the count stays 3 (DISTINCT).
- [ ] No new runtime deps. tsc clean.

## Out of scope

- Ingesting closed/merged PRs from `gh` into a `pr_merged` table. The
  `run` table already has what we need.
- Backfilling `control_audit` with synthetic pr-merge rows for past
  auto-merges. The query change handles past merges automatically.

## Engineering notes

- `src/views.ts` — replace `prCounts.merged` source for the fleet view.
- `src/digest.ts#prActionsByProject` — return a third field
  `merged_via_portal` (the existing audit count) and add a new
  `mergedRunsByProject(db, period)` helper that reads from `run`.
- `web/app.js` — no change (same JSON keys).

## Implementation log

- 2026-05-26 — implementation-dev: flipped status to `in-progress`; opened
  branch `feat/0019-prs-merged-from-runs` off origin/main.
- 2026-05-26 — implementation-dev: PR #39 merged to main (gating checks
  green: `typecheck`, `validate`). Status flipped to `shipped`.
- 2026-05-26 — implementation-dev: wired `mergedRunsByProject(db, period)`
  in `src/digest.ts` to count DISTINCT `pr_number` from shipped runs;
  `weeklyDigest()` now sources `prs_merged` (totals + per-project) from
  the run table and keeps the audit-derived figure on the same JSON
  object as `prs_merged_via_portal`. `src/views.ts#fleetView` also
  exposes a per-project `prs_merged_7d` derived from runs so the home
  grid card has the same honest signal. Added `tests/prs-merged.test.ts`
  covering DISTINCT dedupe, outcome filter, window scoping, multi-project
  attribution, fleetView integration, and the audit→prs_merged_via_portal
  preservation. Updated `tests/digest.test.ts` AC2/AC3/AC7 to seed
  `run.pr_number` (the new source of truth) alongside the legacy audit
  rows. Local gate green: tsc, check-backlog, 211/212 tests pass (1
  skipped pre-existing).
