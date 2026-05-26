---
id: 0005
title: 30-day cost forecast per project
status: in-progress
priority: P1
area: observability
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator, I want the portal to show "at this pace = $X/month"
per project, so that I catch a budget surprise before the end of the
month, not after.

## Why now (four lenses)

### Product Owner
A line of math (mean daily $ × 30) the operator deserves to see in the
portal instead of doing in their head. Pairs with agent-fleet ticket 0004
(daily cap) — forecast tells you what cap to set.

### Stakeholder
Widens the moat on `observability`. Cost honesty across the dashboard.

### Operator
Glance at the portal, see "$12/mo at current rate" per project, sanity-
check against expectations.

### Growth
The "30-day forecast" card is a memorable screenshot.

## Acceptance criteria

- [ ] `src/views.ts` exposes `forecastFor(db, slug)` returning
      `{daily_mean_7d, daily_mean_14d, projected_30d, samples}`.
      Uses the existing `cost_rollup_day` table.
- [ ] If fewer than 3 days of cost data exist, returns
      `{projected_30d: null, reason: "not enough data"}`.
- [ ] `/api/projects/:slug/forecast` exposes this.
- [ ] `web/app.js` per-project card shows "$X/mo (forecast)" derived from
      `daily_mean_7d × 30`. The 14d mean is shown in a tooltip.
- [ ] Total-fleet forecast in the portal footer = sum of per-project
      forecasts.
- [ ] `tests/forecast.test.ts` — seed `cost_rollup_day` with 7 days at $1/day,
      assert projected_30d = $30; seed with 2 days, assert
      `projected_30d: null`.

## Out of scope

- Confidence intervals / variance. Mean only in v1.
- Comparison to a budget cap (the cap is set in agent-fleet's
  `agents.config.sh`; comparing requires reading every manifest — separate
  ticket).
- Weekly / monthly trend charts. Numbers only in v1.

## Engineering notes

- `src/views.ts` — add `forecastFor`.
- `src/server.ts` — add the route.
- `web/app.js` — update per-project card and footer.
- Blocked-by: 0004 (pricing) to make the numbers honest; can ship without
  but should land after.
- No new deps.

## Implementation log

- 2026-05-26 — implementation-dev: branch `feat/0005-cost-forecast` opened;
  ticket flipped `groomed` → `in-progress`. Next: failing tests in
  `tests/forecast.test.ts` for the 7-days-at-$1 happy path and the
  fewer-than-3-days null path, then the `forecastFor` helper +
  `/api/projects/:slug/forecast` route + SPA card/footer.
