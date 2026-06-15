---
id: 0033
title: Yesterday at a glance - single morning card recaps shipped, spent, broken
status: shipped
priority: P1
area: portal
created: 2026-06-01
owner: gtm-innovation
---

## User story

As a fleet operator who opens the portal on my phone at 8:47am with
coffee in one hand and the kid lunchbox in the other, I want one card
at the top of the home page that summarises exactly what my fleet did
between when I closed my laptop last night and now - "shipped 3 PRs,
spent $4.12, one project went amber, streak still alive day 48" - so
that the morning glance is one card, not a six-section scroll, and the
decision to dive deeper is gated on whether anything in the card
actually requires me.

## Why now (four lenses)

### Product Owner
The home page today is composed of strong pieces - the inbox (0017),
temperature dots (0022), streak counter (0026), burndown (0028), tool
mix (0031), digest (0012). Each is correct; together they read like a
dashboard the operator scrolls through. The retention question this
exposes: does the operator open the portal because they HAVE to scroll
through six sections, or because one glance answers "anything to do?"
The first habituates a chore; the second habituates a ritual. A single
"Yesterday's recap" card that pulls the four numbers any operator
actually wants - shipped count, dollars spent, the one thing that
turned amber, streak status - composes the existing primitives into a
single visual that fits above the phone's fold. 0017 + 0022 + 0026 +
0028 + this = one morning glance. Strict subtraction of scroll, no
new data, no new control surface.

### Stakeholder
Widens the moat on `portal` and retention. The "operator forgets it
exists" failure mode named in 0026's stakeholder lens is the single
biggest threat to a local-only tool. 0026 added the streak hook; this
ticket compresses the whole morning ritual into one card that fits in
the PWA's fold (0029). Per the cross-fleet courtiq lesson "a 3am false
alarm costs more trust than a 9am one delivers," the inverse also
holds: a single 9am card that just shows "fleet shipped 3 PRs while
you slept" builds the trust that a stream of widgets never does. The
card is also the only home-page surface that is fundamentally
yesterday-scoped - everything else is current-state - so it has a
distinct mental model and won't be confused with the live inbox.

### User (operator at 9am)
Above the existing inbox, a card titled "Last 24 hours" renders four
inline stats and one one-line verdict:

```
Last 24 hours                                           [tap for digest]
  3 PRs shipped     $4.12 spent     0 anomalies         streak day 48
  fleet-control went amber at 03:14 - budget burndown
```

On a phone, the four stats stack 2x2 with the verdict line below.
The verdict picks the single most important thing that changed: a
band-shift on any project (green->amber->red, in that priority), else
a budget threshold cross (any project hit 75% of cap), else a new
fleet_correlation (0027), else a successful first-ever ship for any
project (a celebration line). Empty 24h (no merges, no anomalies, no
band shifts) renders one quiet line: "All quiet. Streak day 48."
Tapping anywhere on the card opens the existing weekly digest (0012).
The card is sticky-top above the inbox - one glance, then the inbox
below answers "do I act."

### Growth
The "show me" moment is the screenshot of this card at 8:47am - "3
PRs shipped, $4.12 spent, streak 48" - shared on Twitter or sent to
a friend. It is more compelling than 0026's calendar heatmap because
it answers the actual question ("what did it DO?") rather than just
shape ("how often"). A prospective operator who sees this card
understands the value in one read: my agents shipped real work while
I slept. Per the cross-fleet lesson on share-worthy moments, this is
the single card most likely to end up in a Show HN post.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/views.ts` exports `yesterdayGlance(db, now)` returning
      `{window: {start: string, end: string},
      shipped_count: number, spent_usd: number,
      anomalies_open: number, streak_days: number,
      verdict: {kind: string, project_slug?: string, message: string},
      generated_at: string}`. `window` is the trailing 24h ending at
      `now`. `shipped_count` is `merged_pr` rows in window across the
      fleet. `spent_usd` is the sum of `cost_rollup_day` for the
      single calendar day containing `now` (the visible "today"). 
      `anomalies_open` is rows in `anomaly` with `dismissed_at IS NULL`
      created in window. `streak_days` reuses 0026's `fleetStreak()`
      output (no duplicated SQL). Per LESSONS § "node:sqlite's .all()
      needs `as unknown as T[]`", any new row narrowing uses the
      double-cast. Per LESSONS § "time-pinned tests must NOT derive
      seed timestamps from `new Date()`", every seed in the test is
      anchored to a fixed `now` parameter. Test: seed 3 merged PRs +
      2 anomalies + $4.12 in cost_rollup_day, assert the four
      numbers exactly.
- [ ] `verdict` selection: a priority cascade evaluated in order.
      Returns the FIRST non-null match:
      1. `band_shift_red` - any project whose health (0022) is `red`
         today but was NOT `red` 24h ago. Message:
         `"<slug> went red at HH:MM - <last failing check>"`.
      2. `band_shift_amber` - same but for `amber`.
      3. `budget_threshold` - any project whose
         `cost_rollup_day` for today >= 75% of its `daily_budget_usd`
         (from 0021). Message:
         `"<slug> at NN% of daily budget"`.
      4. `fleet_correlation` - any active correlation (0027) in window.
         Message: `"N projects failing with <signature>"`.
      5. `first_ship` - any project whose FIRST EVER `merged_pr` rows
         fell in window. Message:
         `"<slug> shipped its first PR"` (celebration).
      6. `all_quiet` - default. Message: `"All quiet. Streak day N."`
      Test: seed each branch in isolation, assert the chosen verdict.
- [ ] `yesterdayGlance` returns `verdict.kind: "all_quiet"` and a
      grammatically correct streak message even when `shipped_count
      === 0` AND `anomalies_open === 0`. No NaN, no empty string,
      no division by zero. Test: empty DB + 0-day streak, assert
      `"All quiet. Streak day 0."` (zero is fine, not "Streak day -1").
- [ ] `GET /api/fleet/glance` returns the shape. Requires `read`
      scope. Test: hit without auth -> 401; with `read` -> 200 and
      the full shape.
- [ ] `listProjects` (or the home payload) DOES NOT inline the glance
      - the home page fetches it from the new route on render so the
      home-page payload stays small and the glance has its own cache
      header. The home-payload JSON shape is therefore unchanged
      (additive only). Test: snapshot the home payload, assert no
      `glance` key.
- [ ] Caching: the route response sets `Cache-Control: max-age=60`
      so a phone refreshing repeatedly hits a local SW cache (per
      0029) for up to a minute. The handler itself memoises the
      computation for 60s in a module-level Map keyed by `now`
      rounded to the minute. Per LESSONS § "in-process dedup sets
      need an explicit reset hook for tests", expose
      `_resetGlanceCacheForTests()` AND
      `_getGlanceCacheBuildsForTests()` (per LESSONS § "expose a
      build counter for cache-hit tests, not a fetcher swap"). Test:
      two requests within 60s assert the build counter increments
      once; a request after 60s advance increments it again.
- [ ] `web/app.js` renders the card above the inbox section on the
      home page. Layout: title "Last 24 hours" + four inline stats
      (shipped, spent, anomalies, streak) + the one-line verdict.
      The container has `data-testid="yesterday-glance"` for
      stable phone-test hooks. The card is clickable; tapping
      anywhere navigates to `/digest` (0012). Per LESSONS §
      "defence-in-depth secret redaction at the renderer boundary",
      the verdict's `project_slug` and `message` pass through
      `redactSecrets` before insertion. Test: stub each verdict
      kind, assert the rendered DOM contains the expected text and
      the testid.
- [ ] Mobile: at 375px viewport the four stats stack 2x2 (two per
      row), the verdict line wraps cleanly, no horizontal scroll
      (per 0011 conventions). At >=600px the stats live in one row.
      Test: assert via the existing mobile-portal text-level CSS
      contract at both widths.
- [ ] Loading state: while the `/api/fleet/glance` fetch is in
      flight, the card renders a skeleton block (four pulsing
      placeholders + a one-line skeleton verdict) so the page
      layout doesn't jump when the data arrives. Skeleton uses
      reduced-motion-aware CSS animation (per browser
      `prefers-reduced-motion`) - flat-grey when reduced motion is
      requested. Test: stub the fetch as a never-resolving
      promise, assert the skeleton DOM and the `aria-busy="true"`
      attribute; assert no animation classes when
      `matchMedia('(prefers-reduced-motion: reduce)')` matches.
- [ ] Quiet-hours integration: when 0030's `quietHoursActive` is
      `true` AND the verdict is `band_shift_amber` (or any
      non-critical kind), the verdict is demoted - the card
      renders the message but prefixes it with the moon glyph
      (U+1F319) and the small text "(arrived during quiet hours)".
      Critical kinds (`band_shift_red`, `fleet_correlation`) are
      never demoted, matching 0030's gating. Test: stub
      `quietHoursActive: true` + an amber verdict, assert the moon
      prefix; stub same + a red verdict, assert no prefix.
- [ ] Performance: `yesterdayGlance(db, now)` against a fleet of
      10 projects with 90 days of telemetry completes in under
      40ms. The HTTP route end-to-end (cache miss) completes in
      under 100ms. Per LESSONS § "in-process startServer() tests
      need an empty-roots config + run-row seeds", the server-boot
      tests plant a tmp `fleet-control.config.json` in cwd and
      restore on cleanup. Test: seed the dataset, time both,
      assert thresholds (skip if `process.env.PERF !== "1"`).
- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-string
      composition. No JSON-shape break to any existing `/api/...`
      route (the new `/api/fleet/glance` is net-new; the
      home-payload is unchanged). No schema migration - reads
      existing tables only. Per LESSONS § "julianday() drifts ~10us
      per timestamp; decompose with strftime for sub-ms diffs", any
      sub-minute window arithmetic uses the strftime decomposition.

## Out of scope

- A configurable "last N hours" window. v1 is fixed at 24h - the
  morning glance is fundamentally diurnal. A weekly card already
  exists in 0012 (digest).
- A "what's about to ship" predictive line. The glance is rear-view
  only. A predictive view requires the forecaster (0005) plus a
  separate UI surface.
- Per-project glance cards (one card per project on the home page).
  The glance is fleet-wide by design - the project page is the
  drill-down. A per-project glance is a clean follow-up if asked.
- LLM-authored verdicts. The verdict cascade is deterministic; the
  operator gets the same message for the same data on every run.
- Notifications when the verdict changes. Inbox (0017) and ntfy
  (0009) already handle alerting; the glance is a pull surface
  only.
- Custom verdict templates (operator-defined phrasing). v1 ships
  the six templates above.
- An "all-time" stats card (lifetime shipped count, lifetime
  spent). v1 is yesterday-scoped only - lifetime is what the
  leaderboard (0014) and digest (0012) already cover.

## Engineering notes

- `src/views.ts` - new `yesterdayGlance(db, now)` helper. Composed
  of four sub-queries (shipped count, spent usd, anomalies open,
  streak via 0026's `fleetStreak`) plus the verdict cascade as a
  series of `?? null` chained selectors. Per LESSONS §
  "node:sqlite's .all() needs `as unknown as T[]`", every row
  narrowing uses the double-cast. Per LESSONS § "julianday()
  drifts ~10us per timestamp", the 24h window arithmetic uses the
  strftime decomposition rather than a julianday delta.
- `src/server.ts` - one new route `GET /api/fleet/glance`. Reuse
  the existing `read` scope middleware. The 60s memo cache is a
  module-level `Map<string, {value, expires_at}>` per LESSONS §
  "expose a build counter for cache-hit tests, not a fetcher swap"
  - expose `_resetGlanceCacheForTests()` and
  `_getGlanceCacheBuildsForTests()`.
- `web/app.js` - new `renderYesterdayGlance(data)` helper called
  from the existing home-page render path. Pure DOM-string
  concatenation; no new template engine. The skeleton block is a
  separate `renderGlanceSkeleton()` shown until the fetch
  resolves. Both pass operator strings through `redactSecrets`
  per LESSONS § "defence-in-depth secret redaction at the
  renderer boundary."
- `web/style.css` - one selector group for the card and the
  skeleton animation. Reuse existing CSS variables - no new
  palette. The skeleton uses `@media (prefers-reduced-motion:
  reduce)` to flatten the animation per accessibility convention.
- `src/inbox.ts` - one tiny extension: the glance helper imports
  `isQuietNow` from 0030's `src/quiet_hours.ts` to gate the
  verdict demotion. No changes to `fleetInbox` itself.
- `tests/glance.test.ts` (new) - one `test(...)` per AC checkbox.
  Per LESSONS § "time-pinned tests must NOT derive seed timestamps
  from `new Date()`", every seed timestamp is anchored to the
  test's pinned `now`. Per LESSONS § "in-process startServer()
  tests need an empty-roots config + run-row seeds", the server
  tests plant a tmp `fleet-control.config.json` in cwd and
  restore on cleanup.
- No new runtime deps. No schema migration. Pairs with 0017 (the
  glance sits ABOVE the inbox - one card "what happened?" then
  the inbox answers "what do I act on?"), 0022 (the verdict's
  band-shift detection reuses `projectHealth`), 0026 (the streak
  number reuses `fleetStreak`), 0027 (the correlation verdict
  reads from the same `anomaly` rows), 0028 (the budget-threshold
  verdict reuses the burndown's daily-budget logic), 0030 (the
  moon-glyph demotion matches the quiet-hours pattern), and 0029
  (the card is the FIRST thing a paired phone sees post-install -
  the install-to-value moment ends here).

## Implementation log

(Appended by the implementation-dev agent during execution.)

- 2026-06-01 - branch `feat/0033-yesterday-glance` opened
- 2026-06-01 - failing test added in `tests/glance.test.ts`
- 2026-06-01 - PR #79 opened, CI green (typecheck + validate)
- 2026-06-01 - merged to main via auto-merge squash
