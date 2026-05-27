---
id: 0021
title: Soft daily budget with autopause when a project blows the cap
status: shipped
priority: P1
area: control
created: 2026-05-27
owner: gtm-innovation
---

## User story

As a fleet operator who has watched a runaway agent eat $40 in two hours
on a previous tool, I want a per-project *soft* daily budget that, once
breached, automatically pauses the project's launchd ship job and posts
one ntfy alert — held paused until I tap "resume" in the portal — so
that letting agents run unattended overnight stops feeling like a
gamble.

## Why now (four lenses)

### Product Owner
`set-budget` (0007 era, see `src/control.ts` ~line 282) already writes
`MAX_DAILY_USD` into the manifest, but the engine treats it as a soft
target — when the daily rollup crosses it, nothing in the control plane
*stops* the next ship tick. The operator finds out the next morning.
Closing this loop locally — "spend > cap → bootout the ship plist; mark
project paused" — turns the field from advisory to enforced without
adding a new operator concept. One concept (`MAX_DAILY_USD`), two new
behaviours (autopause, resume).

### Stakeholder
Widens the moat on `control` and trust. The single biggest unstated
fear about handing the keys to autonomous coding agents is the cost
tail. Every other tool in this space asks the operator to trust the
LLM's own self-restraint; fleet-control already measures the spend
locally and already owns the launchd plist, so it can stop the bleed
without a cloud round-trip. That is a moat property a SaaS dashboard
literally cannot match — it would need root on the operator's box.

### User (operator at 9am)
Project card grows a small state pill: `running` (green), `paused·cost`
(amber with a "Resume" button), `paused·manual` (the existing
keep-running state). One ntfy push on the autopause event, deduped per
`(slug, day)` so the operator doesn't get hammered if the rollup
re-fires. Resume is one tap — restores the plist and clears the
pause-state row. On the phone, all three reachable in the same swipe.

### Growth
"My agents can't spend more than $X without my thumbprint" is the
single most quotable sentence about this product. Pair it with the
0015 status badge (which can grow a `paused·cost` colour) and the
portal makes a more convincing "show me" than any feature in the
backlog.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] Schema migration: add `project_pause` table idempotently in
      `src/db.ts`:
      ```sql
      CREATE TABLE IF NOT EXISTS project_pause (
        project_id INTEGER PRIMARY KEY REFERENCES project(id),
        reason TEXT NOT NULL,
        triggered_at TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        detail_json TEXT
      );
      ```
      `reason` is one of `cost_cap`, `manual` (manual is reserved for a
      future ticket — v1 only writes `cost_cap`). Test: insert + select
      round-trip; assert `INSERT OR REPLACE` so re-triggering the same
      day is idempotent. Per `docs/LESSONS.md` § no backticks inside
      template-literal SQL strings, keep identifiers plain.
- [ ] `src/anomaly.ts` (or a new `src/budget_guard.ts` if cleaner)
      exports `evaluateBudgetGuards(db, now)` returning
      `Array<{project_id, slug, spent_usd, cap_usd, prior_paused: boolean}>`.
      For every project whose manifest carries a positive
      `MAX_DAILY_USD` and whose `cost_rollup_day` row for `day = local
      YYYY-MM-DD` has `cost_usd >= MAX_DAILY_USD`, return one row. Test:
      seed two projects (one over, one under), assert exactly one row
      returned with the right slug.
- [ ] Pause action: when `evaluateBudgetGuards` returns a row whose
      `project_id` is NOT already in `project_pause`, the daemon calls
      `src/control.ts`'s shell-out path to `launchctl bootout`
      the project's ship plist (the same code path the existing
      `keep-running` / `eng-toggle` actions use). The argv MUST be
      passed via `execFile` per AGENTS.md — no shell-string composition.
      Insert a row into `project_pause` with `reason='cost_cap'`,
      `triggered_by='budget_guard'`, `detail_json` = `{spent_usd, cap_usd, day}`.
      Test: stub the runner per `docs/LESSONS.md` § shell-out modules
      need an injectable runner, run the guard, assert the runner was
      called with `["bootout", ...]` and that the pause row landed.
- [ ] Idempotence: a second pass on the same day where the project is
      already paused MUST NOT call `launchctl` again and MUST NOT
      insert a duplicate row. Test: run the guard twice in a row,
      assert the runner is called exactly once.
- [ ] ntfy push: on the first pause for a given `(slug, day)`, post one
      `cost_cap_pause` event through the existing dedup-aware
      `src/ntfy.ts` surface — dedup key is
      `cost_cap_pause:${slug}:${day}` so re-firing the guard never
      re-pings. Title: "Paused {slug} — spent ${X} ≥ ${cap}". Test:
      stub the ntfy fetcher per `_resetDedupForTests`, run the guard
      twice, assert exactly one POST.
- [ ] `POST /api/control` action `resume-paused` (new) clears the
      `project_pause` row for the named slug, then re-bootstraps the
      ship plist via the same `bash install.sh` path
      `keep-running`/`eng-toggle` use. Requires `write` scope. Test:
      hit without auth → 401; with `write` and a paused project →
      200 + plist re-bootstrapped + pause row gone.
- [ ] `GET /api/projects` adds a `paused` field to each project row
      (one of `null`, `"cost_cap"`, `"manual"`). The field is purely
      additive — no other field changes shape. Test: seed a paused
      project, assert the field, then GET again and assert no other
      JSON shape change vs the pre-ticket fixture (snapshot test).
      AGENTS.md § no JSON-shape break.
- [ ] `web/app.js` renders a `paused·cost` pill on the project card
      with an inline "Resume" button when `paused === "cost_cap"`.
      Empty case (no paused projects) renders nothing new. Mobile
      stacks per 0011 conventions. Test: stub the API with each state,
      assert the DOM shape including the resume button's `data-action`
      attribute.
- [ ] Status badge (0015): when a project is paused for cost, its
      `/api/projects/:slug/badge.svg` colour shifts to the same amber
      the pill uses (existing badge palette has one — see
      `src/badge.ts`). Test: render the badge for a paused vs running
      project, assert the colour token differs.
- [ ] Safety: the guard MUST NOT pause a project whose `MAX_DAILY_USD`
      is unset, zero, or non-numeric — those projects opt out by
      omission. Test: seed a project with the manifest var missing,
      blow the (theoretical) cap, assert no pause row, no `launchctl`
      call.
- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-string
      composition (the `_setRunnerForTests` seam asserts this in the
      same shape as 0010 / 0016).

## Out of scope

- A *hard* per-tick budget that interrupts a mid-run agent (would
  require killing a `claude` process, much higher blast radius).
  v1 stops the *next* ship; the in-flight one finishes.
- Per-phase budgets (`MAX_DAILY_SHIP_USD` vs `MAX_DAILY_ENG_USD`).
  v1 is one cap covering all phases — matches the existing
  `MAX_DAILY_USD` field semantics.
- Weekly / monthly caps. Daily-only is the unit the rollup already
  carries; longer horizons can ride on top later.
- Auto-resume after midnight rollover. The operator explicitly resumes
  — that confirmation is the entire point of "soft" vs "hard".
- A configurable cap-breach grace (e.g. "pause at 110% of cap"). v1 is
  hit-or-miss at the exact value; a multiplier is a clean follow-up.

## Engineering notes

- `src/budget_guard.ts` (new) — pure-DB read for the guard query, then
  delegates to a runner-injected pause action. Same seam pattern as
  `src/doctor.ts` and the 0010 register-url action. Per
  `docs/LESSONS.md` § `node:sqlite`'s `.all()` needs `as unknown as T[]`
  cast for typed rows.
- `src/control.ts` — extract a small `pauseShipPlist(slug)` helper
  (and `resumeShipPlist(slug)`) reused by both the new action and the
  guard. The helper uses `execFile` with an argv array — never compose
  a shell string with `slug`.
- `src/daemon.ts` — call `evaluateBudgetGuards` once per ingest tick
  after the cost rollup runs (the rollup is what populates the day's
  row). Cheap query — one row per project.
- `src/db.ts` — append the `project_pause` table to SCHEMA. No
  backticked identifiers inside the template literal.
- `src/views.ts` — `listProjects` adds the `paused` field by LEFT
  JOIN'ing `project_pause`.
- `src/ntfy.ts` — re-use the existing dedup surface; the new event type
  is one row in the `kind` enum.
- `src/badge.ts` — one new colour branch; existing palette already has
  amber for warn states.
- `web/app.js` + `web/style.css` — small render change on the project
  card, one new selector group.
- No new runtime deps. Pairs with 0017 (paused projects belong on the
  inbox under a new `paused_cost` kind in a follow-up ticket — out of
  scope here), 0008 (anomaly fires on cost spikes; this is the
  enforcement layer that the alerter currently lacks), and 0015 (badge
  colour reflects pause state).

## Implementation log

- 2026-05-27: status → in-progress; branch `feat/0021-soft-budget-autopause`.
  Implementation order: db schema → budget_guard module → control pause/resume
  helpers → daemon hookup → views.paused field → /api/control resume-paused →
  badge amber → ntfy event → SPA pill + Resume button.
- 2026-05-27: shipped via PR #47; status → shipped.
