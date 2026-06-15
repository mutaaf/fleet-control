---
id: 0038
title: Monday morning catch-up - bridges the weekend gap between Friday wrap and Yesterday glance
status: shipped
priority: P1
area: portal
created: 2026-06-05
owner: gtm-innovation
---

## User story

As a fleet operator opening the laptop Monday at 9am after a weekend
away, I want one card at the top of the home page that appears only on
Mondays summarising what the fleet did since I last looked - "while you
were away (Fri 5pm to now): 6 PRs merged, $8.20 spent, 2 PRs waiting
for review, 1 self-cancel approaching on courtiq, 0 anomalies" - so
that the 48-hour weekend gap is bridged in one glance and I know what
needs me before I scroll.

## Why now (four lenses)

### Product Owner
The fleet now has a daily ritual (0033 Yesterday at a glance) and a
weekly close-of-business ritual (0037 Friday wrap). The Monday morning
re-entry is the third pillar of the retention loop and currently the
weakest moment: the operator left at Friday 5pm with a Friday-wrap
screenshot in hand, and returns Monday 9am to a 0033 card that only
covers the last 24 hours - missing Saturday and Sunday. The catch-up
card is pure composition over existing data: same `cost_rollup_day`,
`pr`, `anomaly`, and `inbox` tables the daily and weekly cards already
join, but with a "since Friday 5pm operator-local" window. The card
hides itself Tuesday through Sunday so it never becomes noise. The
triad (Monday catch-up + daily glance + Friday wrap) completes the
weekly-rhythm loop without inventing a new data layer.

### Stakeholder
Widens the moat on `portal` retention - specifically the re-engagement
axis. The biggest churn risk for a personal observability tool is the
operator who skipped a weekend and returns to a wall of stale info; if
the first thing they see Monday is a noisy home page where they have
to mentally compute "what changed since Friday," they bounce. The
catch-up card is the closest thing in the backlog to a "welcome back"
moment - the same retention play that good email clients run with
"messages while you were away." Per the cross-fleet courtiq lesson
"surfaces that bring the operator back after distraction matter as
much as the first-60-second pitch," this is the re-entry ritual. Cheap
to ship (one helper, one route, one card, one day-of-week gate), high
retention payoff (the first thing the operator sees Monday determines
whether they keep the laptop open), and no new schema.

### User (operator at Monday 9am)
On Mondays ONLY, ABOVE the 0037 Friday-wrap card (which is invisible
on Mondays) and the 0033 yesterday-glance card, a wider catch-up card
appears:

```
While you were away                Fri 5:00pm → Mon 9:14am · 64h
  6 PRs merged    $8.20 spent    2 PRs waiting    1 alert
  Biggest weekend ship: courtiq · cost-per-pr summary (#312) merged Sat
  Needs you now: fleet-control PR #91 (Send-back, 28h ago)
```

The four-stat grid mirrors 0033 and 0037 for visual consistency. The
window starts at the operator's local Friday 17:00 (or the last seen
home-page hit, whichever is more recent - we track this via a
lightweight `last_seen_at` row in the existing `watermark` table) and
ends at `now`. The "biggest weekend ship" picks the most-impactful
merged PR in the weekend window using the same `additions + deletions`
score as 0037's biggest-win. The "needs you now" surfaces the single
most urgent open inbox item across the fleet, prioritising
`pr_review` > `self_drift` > `self_cancel_warn` > `hung_run`. Tap the
card to open `/inbox`. Tuesday-Sunday: the card is invisible, no DOM
element, no whitespace - byte-identical home page to today.

### Growth
The screenshot worth sharing is "every Monday morning fleet-control
greets me with a single card summarising the weekend - here's mine:
6 PRs while I was at my kid's soccer game" shared Monday 9am on
Twitter (the highest dwell-time slot for "back to work" content).
This is a DISTINCT artifact from 0033 (daily recap, Tuesday-Friday
mornings) and 0037 (Friday afternoon close-of-business) - the three
together complete the weekly retention surface. The "show me" pitch:
"Monday morning, you don't have to scroll. Fleet-control tells you
in one card what happened over the weekend."

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/views.ts` exports `mondayCatchUp(db, now: Date, opts?:
      {tz?: string, lastSeenAt?: string}): {window: {start: string,
      end: string, hours: number, anchor: "friday_17" | "last_seen"},
      merged_prs: number, spent_usd: number, waiting_prs: number,
      open_alerts: number, biggest_ship: {project_slug: string,
      pr_number: number, pr_title: string, ticket_id: string | null,
      merged_at: string, size_score: number} | null, needs_you:
      {kind: "pr_review" | "self_drift" | "self_cancel_warn" |
      "hung_run", project_slug: string, message: string, link: string,
      age_hours: number} | null, generated_at: string}`. The window
      starts at the LATER of (a) Friday 17:00 in the given tz and (b)
      `lastSeenAt`. When the optional `lastSeenAt` is omitted, only
      (a) applies. `merged_prs` is `state='MERGED' AND is_agent=1 AND
      fetched_at >= window.start`; `spent_usd` sums `cost_rollup_day`
      over the window; `waiting_prs` is open agent PRs awaiting
      review (`state='OPEN' AND is_agent=1`); `open_alerts` counts
      `alert.resolved_at IS NULL`. Per LESSONS § "node:sqlite's
      .all() needs `as unknown as T[]`", every row narrowing uses
      the double-cast. Per LESSONS § "julianday() drifts ~10us per
      timestamp", window arithmetic uses strftime decomposition.
      Per LESSONS § "time-pinned tests must NOT derive seed timestamps
      from `new Date()`", every seed anchors to the pinned `now`.
      Test: seed 6 merged PRs + $8.20 cost + 2 open PRs + 1 alert
      since Friday 5pm, assert the four numbers exactly.
- [ ] `biggest_ship` selection: among merged PRs in window across all
      projects, pick the one with the highest `additions + deletions`
      score (a NULL or zero score falls back to most-recent-merge
      order). When zero merged PRs in window, `biggest_ship: null`.
      The ticket id is resolved from `ticket_commit_link` (0018) when
      present. Test: seed 5 merged PRs with known additions/deletions,
      assert the highest-scoring one is returned with its ticket-id.
- [ ] `needs_you` cascade evaluated in priority order, returning the
      FIRST non-null match:
      1. Oldest open `pr_review` inbox row (a PR with state='OPEN'
         and a `reviewed-changes` outcome on the latest run, OR an
         agent PR with no outcome and age > 12h).
      2. Any active `self_drift` anomaly (0034) - message includes
         the project slug and metric.
      3. Any open `self_cancel_warn` alert (0020 family) - message
         includes the days remaining.
      4. Any open `hung_run` alert - message includes the phase + age.
      5. `null` (omit the line entirely).
      Test: seed each branch in isolation, assert the chosen
      needs-you item; seed all four simultaneously, assert pr_review
      wins.
- [ ] `isMonday(now: Date, tz?: string)` helper: returns `true` when
      `now`'s day-of-week in the given timezone is Monday (using
      `Intl.DateTimeFormat` with `weekday: 'short'` so no `tz`
      library is needed). Default tz is the operator's local. Test:
      pin `now` to Monday 02:00 UTC + tz `America/Los_Angeles`,
      assert `false` (still Sunday 19:00 in LA); pin to Monday 18:00
      UTC + tz `America/New_York`, assert `true`.
- [ ] Window anchor: `weekendWindowStart(now: Date, tz: string,
      lastSeenAt?: string): {start: string, anchor: "friday_17" |
      "last_seen"}` returns the later of (a) most recent Friday
      17:00 in `tz` (rendered as ISO UTC) and (b) `lastSeenAt`. When
      both are absent, defaults to 60h before `now`. Test: pin `now`
      to Monday 9am ET, no `lastSeenAt`, assert start is Friday
      17:00 ET converted to UTC; same `now` with `lastSeenAt =
      Sunday 8pm ET`, assert start is the Sunday timestamp and
      anchor is `last_seen`.
- [ ] `GET /api/fleet/monday-catchup` returns the shape from AC1
      PLUS a top-level `visible: boolean` field set by
      `isMonday(now, tz)` - the route always responds 200 so the
      SPA can pre-fetch on any day, but the SPA only renders when
      `visible: true`. Requires `read` scope. Accepts an optional
      `?tz=<iana>` param whitelisted against
      `Intl.supportedValuesOf('timeZone')` before use. Test: hit
      without auth -> 401; with `read` on a non-Monday -> 200 with
      `visible: false` and `null` stats; on a Monday -> 200 with
      `visible: true` and populated stats.
- [ ] Last-seen tracking: every authenticated GET to
      `/api/fleet` upserts a `watermark` row keyed
      `home_last_seen_<actor>` (`actor` = `loopback` or the token
      id) with the current ISO timestamp. The catch-up route reads
      this row to set the window's `lastSeenAt`. Per LESSONS § "no
      backticks inside template-literal SQL strings", any new SQL
      uses plain identifier quoting. No new table - the existing
      `watermark` table is the chosen seam. Test: hit `/api/fleet`
      twice 30 minutes apart on a Monday, assert the catchup window
      starts at the FIRST hit (not Friday 17:00).
- [ ] Caching: the route response sets `Cache-Control: max-age=180`
      (3 min - the catch-up data changes faster than weekly wrap
      because new PRs may merge mid-morning) and the handler
      memoises by `(actor_key, day_iso)`. Per LESSONS § "in-process
      dedup sets need an explicit reset hook for tests", expose
      `_resetMondayCatchUpCacheForTests()` AND
      `_getMondayCatchUpCacheBuildsForTests()` per LESSONS § "expose
      a build counter for cache-hit tests, not a fetcher swap".
      Test: two calls within 3 min on the same day assert the
      build counter increments once; advance to a new calendar
      day, assert another increment.
- [ ] `web/app.js` renders the catch-up card on the home page ONLY
      when the API response has `visible: true`. The card sits at
      the absolute top of the home page (above Friday-wrap which is
      always invisible on Monday, above yesterday-glance, above the
      0035 cost-per-PR summary). Layout: title "While you were
      away" + the window range + four inline stats + the
      biggest-ship line + the needs-you line (omitted when null).
      On non-Mondays the card is NOT in the DOM at all - the home
      page is byte-identical to a pre-0038 render. Per LESSONS §
      "defence-in-depth secret redaction at the renderer boundary",
      the biggest-ship PR title and the needs-you message pass
      through `redactSecrets` before insertion. The container has
      `data-testid="monday-catchup"` for stable phone-test hooks.
      Tapping the card navigates to `/inbox`. Test: stub `visible:
      true`, assert the DOM contains the testid and the expected
      stats; stub `visible: false`, assert the testid is absent.
- [ ] Mobile: at 375px viewport the four stats stack 2x2 (matching
      the 0033 and 0037 card layouts for visual consistency); the
      window range collapses below the title; the biggest-ship and
      needs-you lines wrap cleanly, no horizontal scroll (per 0011
      conventions). At >=600px the stats live in one row. Test:
      assert via the existing mobile-portal text-level CSS contract
      at 375px and 600px.
- [ ] Quiet-hours integration: when 0030's `quietHoursActive` is
      `true` (e.g. operator browsing very early Monday morning
      before the start of their day), the catch-up card is NOT
      demoted (it's a pull surface, not a push). The card itself
      is the antidote to push - "the operator should not need
      Sunday-night notifications because Monday morning the card
      will recap." Test: stub quiet hours active, assert the card
      still renders with full stats.
- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-string
      composition - the `?tz=` param is the only operator-supplied
      input and is whitelisted against
      `Intl.supportedValuesOf('timeZone')` before use. No JSON-shape
      break to any existing `/api/...` route - the new
      `/api/fleet/monday-catchup` is net-new; the home payload is
      unchanged. No schema migration - the `home_last_seen_<actor>`
      key reuses the existing `watermark(source, cursor, updated_at)`
      table.

## Out of scope

- A configurable "catch-up day" (Tuesday catch-up after a long
  weekend, post-holiday catch-up). v1 is Monday-only - the
  weekly re-entry ritual is fundamentally Monday for the
  operator persona. A configurable surface adds a knob with
  no obvious user.
- A Sunday-NIGHT push notification ("here's what's waiting for
  you Monday"). The card is a pull surface only; push lives
  in 0009 ntfy and would defeat the "Monday morning surprise"
  retention beat.
- A multi-week catch-up history ("show me every Monday for the
  last 4 weeks"). The card is single-window only.
- Per-project catch-up cards (one per project on the project
  page). The fleet-wide catch-up IS the value; per-project
  catch-up is just yesterday-glance under a different name.
- Auto-mark-as-read for PRs the operator viewed in the catch-up
  card. Read tracking is a different feature with its own UX
  surface.
- LLM-authored "what to celebrate this weekend" narratives. The
  biggest-ship line picks deterministically from existing data;
  LLM-narration adds runtime cost.
- A "catch-up me up since I was last AT MY DESK" granularity
  (tracking device-level presence). The `last_seen_at`
  watermark is per-actor (loopback vs token id), which is
  enough for v1; finer-grained presence is over-engineering.
- Custom window overrides ("show me the catch-up for the
  last 5 days"). The card is current-weekend only. The full
  digest (0012) already supports arbitrary windows.

## Engineering notes

- `src/views.ts` - new `mondayCatchUp(db, now, opts)` helper next
  to the existing `yesterdayGlance` and `fridayWrap`. The four
  stats reuse the same SQL shapes as `fridayWrap` but with a
  custom window (Friday 17:00 -> now). The `biggest_ship` query
  is the same shape as `fridayWrap.biggest_win` joined to
  `ticket_commit_link` (0018). The `needs_you` cascade is four
  sub-queries with the existing `inbox`, `anomaly`, and `alert`
  tables. `isMonday` and `weekendWindowStart` are small helpers
  using `Intl.DateTimeFormat`. Per LESSONS § "node:sqlite's
  .all() needs `as unknown as T[]`", every row narrowing uses
  the double-cast. Per LESSONS § "julianday() drifts ~10us per
  timestamp", window arithmetic uses strftime.
- `src/server.ts` - one new route `GET
  /api/fleet/monday-catchup`. Reuse the existing `read` scope
  middleware. The 3-min memo cache is keyed by
  `(actor_key, day_iso)` per LESSONS § "expose a build counter
  for cache-hit tests, not a fetcher swap" - expose
  `_resetMondayCatchUpCacheForTests()` and
  `_getMondayCatchUpCacheBuildsForTests()`. The `?tz=` param is
  whitelisted against `Intl.supportedValuesOf('timeZone')`
  before use. The `/api/fleet` handler grows a single-line
  upsert of `home_last_seen_<actor>` in the existing
  `watermark` table - that is the ONLY behavioural change to
  an existing route. The JSON shape of `/api/fleet` is
  unchanged.
- `web/app.js` - new `renderMondayCatchUp(data)` helper called
  from the existing home-page render path. Inserted at the
  absolute top of the home column; when `visible: false` the
  helper returns an empty string so no DOM element is emitted.
  The fetch happens unconditionally on home page load (the
  server's day-of-week gate is the single source of truth).
  Per LESSONS § "defence-in-depth secret redaction at the
  renderer boundary", every operator-visible string passes
  through `redactSecrets`.
- `web/style.css` - one selector group for the catch-up card.
  Reuse the existing 0033 and 0037 card layout patterns to
  stay visually consistent (`.glance-card` shape if that is
  the chosen pattern). No new CSS variables.
- `tests/monday-catchup.test.ts` (new) - one `test(...)` per
  AC checkbox. Per LESSONS § "time-pinned tests must NOT
  derive seed timestamps from `new Date()`", every seed
  timestamp anchors to the test's pinned `now`. The `isMonday`
  and `weekendWindowStart` tests pin to known Mondays across
  multiple timezones including DST boundaries. Per LESSONS §
  "in-process startServer() tests need an empty-roots config
  + run-row seeds", the server tests plant a tmp
  `fleet-control.config.json` in cwd and restore on cleanup.
- No new runtime deps. No schema migration - composes existing
  tables only (`watermark` carries the last-seen marker).
  Pairs with 0033 (the daily counterpart), 0037 (the weekly
  close-of-business counterpart - together they form the
  weekly re-engagement triad), 0017 (the inbox is the
  needs-you cascade source and the tap-through destination),
  0018 (the ticket-id resolution for the biggest-ship line),
  0020 + 0034 (the alert and drift sources for the needs-you
  cascade), and 0030 (quiet hours is acknowledged but does
  not demote the pull card).

## Implementation log

- 2026-06-05 — implementation-dev (Opus 4.7): branch `feat/0038-monday-catchup-card`.
  Writing failing tests for each AC, then implementing `mondayCatchUp(db, now, opts)`
  + `isMonday` / `weekendWindowStart` helpers in `src/views.ts`, the
  `/api/fleet/monday-catchup` route + memo cache + last-seen watermark upsert in
  `src/server.ts`, and the `renderMondayCatchUp(data)` helper in `web/app.js`.
  Schema reconciliation per the 2026-06-05 LESSONS entry: production ingester
  writes `pr.state = 'open'` lowercase for open PRs; merged PRs are seeded as
  `'MERGED'` upper-case (the codebase convention every other view uses). The
  helper queries match this exact casing.
- 2026-06-05 — Shipped via PR #93 (squash-merged into main). CI green
  (typecheck + validate). All 24 monday-catchup tests pass locally.
