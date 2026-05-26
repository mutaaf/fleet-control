---
id: 0012
title: Weekly "what shipped" digest with wins and trends
status: proposed
priority: P2
area: observability
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator who runs the kit across multiple side projects, I
want a Monday-morning digest of last week's wins — PRs merged, $ trend
per project, anomalies cleared, runs that self-cancelled to save budget
— so that the autonomous loop produces a visible "story of the week"
instead of feeling like an undifferentiated stream of background runs.

## Why now (four lenses)

### Product Owner
The portal answers "what's happening now" well. It does not answer "what
did the fleet accomplish since I last looked closely?" An operator who
opens the portal every day sees small incremental changes and loses the
sense of cumulative progress; an operator who opens it weekly has no
landing surface for catch-up. A digest is one route, one query bundle,
one rendered markdown file — small surface, large emotional payoff. It
also serves as a forcing function for the operator's "should I keep
running this project?" question, because each project's row tells them
exactly what the agent did for them this week.

### Stakeholder
Widens the moat on `observability` in the *narrative* dimension — not
"more telemetry" but "telemetry that explains itself". Every analogous
SaaS that does this charges money for it; we do it locally, no LLM, no
external service. The digest is also the foundation for the eventual
ntfy "weekly summary" push (0009 builds the channel; this builds the
content).

### User (operator at 9am, looking at the portal)
Monday at 9am, opens the portal, sees a "Last week" banner at the top of
the home page: "5 PRs merged · 2 sent back · $4.20 spent · 1 anomaly
cleared". One tap expands the full digest as a scrollable, mobile-
friendly card with the per-project breakdown. They can also run
`fleetctl digest --week` from the terminal and get the same content as
markdown, suitable for pasting into a personal log.

### Growth
"Here's what my agents did for me this week" is the highest-shareable
weekly artifact this product can produce. It's a screenshot a curious
friend will ask about, and it's a markdown file the operator can post in
their own weekly review. Every digest the operator shares is an organic
acquisition surface.

## Acceptance criteria

Each box maps 1:1 to a test scenario the dev agent writes.

- [ ] `src/digest.ts` (new) exports `weeklyDigest(db, opts?)` returning a
      structured object:
      ```ts
      {
        period: { start: string, end: string }, // ISO dates, end exclusive
        totals: { runs: number, prs_merged: number, prs_sent_back: number,
                  cost_usd: number, self_cancels: number, anomalies: number },
        projects: Array<{ slug, name, runs, prs_merged, prs_sent_back,
                          cost_usd, top_phase: string,
                          delta_cost_vs_prior_week_pct: number | null,
                          notable: string[] }>,
        narrative: string[]   // 3-7 plain-English bullets summarizing the week
      }
      ```
      Test: seed fixture data spanning 14 days, call helper for last 7,
      assert numeric totals match the fixture and projects array is
      sorted by `cost_usd` descending.
- [ ] `narrative` bullets are deterministic, not LLM-generated. The
      generator picks from a fixed set of templates (`"<slug> shipped
      <N> PRs"`, `"<slug> spent ${X}, <±Y%> vs last week"`, `"<slug>
      self-cancelled <N> times — caught a runaway"`, `"<N>
      anomal{y|ies} flagged on <slug>"`). Test: seed a scenario, assert
      the bullet strings match the templates verbatim.
- [ ] `prs_merged` and `prs_sent_back` are computed from the existing
      `pr` table (state transitions implied by `fetched_at` + `state`
      snapshots) PLUS the `control_audit` rows for `pr-merge` and
      `pr-changes` actions in the window. Test: insert audit rows, assert
      counts.
- [ ] `delta_cost_vs_prior_week_pct` compares to the prior 7-day window.
      Returns `null` if the prior window has zero cost (avoid divide-by-
      zero). Test: prior week $0, this week $5 → `null`. Prior $4, this
      $5 → `25.0`.
- [ ] `GET /api/digest/week` returns the JSON shape. Requires `read`
      scope. Cached in-memory for 5 min keyed by the period (cheap to
      recompute; small protection against polling). Test: hit twice in
      quick succession, assert the second hit doesn't re-query the
      database (use a counter helper).
- [ ] `web/app.js` home page renders a "Last week" banner at the top
      with the totals line. Tapping it expands the per-project rows
      inline. No new route. Test: stub the API, assert the banner DOM
      contains the merged-PR count.
- [ ] `bin/fleetctl.ts digest [--week|--last-7]` writes the digest as
      markdown to stdout in a stable format that diffs cleanly. Test:
      run against a seeded DB, assert stdout matches a fixture file
      character-for-character.
- [ ] `bin/fleetctl.ts digest --save` additionally writes the markdown
      to `~/.local/state/fleet-control/digests/YYYY-Www.md` (idempotent
      per ISO week — re-running the same week overwrites). Test: run
      twice, assert one file exists with the expected name.
- [ ] No new runtime deps. No new schema (everything is a SELECT against
      existing tables). `tsc --noEmit` clean. No shell-string
      composition.

## Out of scope

- LLM-generated prose. Templates only. The brief is explicit: no LLM
  calls in fleet-control, ever.
- Per-day daily digest. Weekly only in v1.
- Email delivery. Local markdown + portal banner only. (If the operator
  wants email, they pipe `fleetctl digest --week` to `mail` themselves.)
- Comparing across operators / publishing publicly. The shared-snapshot
  use case lives in ticket 0013, not here.
- Rich charts. Numbers + small ascii sparkline at most, if at all.

## Engineering notes

- `src/digest.ts` — pure SQL + small string-template helpers. Keep all
  queries parameterized.
- `src/server.ts` — add the `/api/digest/week` route.
- `web/app.js` — extend the home page render with the banner.
- `bin/fleetctl.ts` — add a `digest` subcommand.
- Files written: `~/.local/state/fleet-control/digests/`. Make sure the
  helper `mkdir -p`'s the directory via `fs.mkdir({recursive: true})`.
- No new runtime deps. No schema migration.
- Pairs naturally with 0009 (ntfy) later: a "weekly digest" topic post
  becomes a 1-line addition once both ship.

## Implementation log

(Appended by the implementation-dev agent during execution.)
