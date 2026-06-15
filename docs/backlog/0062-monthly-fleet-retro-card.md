---
id: 0062
title: Monthly fleet retro card - one home-page card on the first weekday of each month surfaces month-over-month deltas so the operator gets a reflection ritual they would not skip
status: shipped
priority: P1
area: observability
created: 2026-06-15
owner: gtm-innovation
---

## User story

As a fleet operator who already opens the portal every weekday morning
(per 0033 yesterday-glance, 0037 Friday wrap, 0038 Monday catch-up, 0059
biggest-surprise) but never compares THIS MONTH to LAST MONTH because no
existing card answers "is the fleet getting better or worse over time",
I want ONE compact "monthly retro" card that shows up on the home page
ONLY on the first weekday of each calendar month - rendering month-over-
month deltas on the four numbers that matter (PRs shipped, $ spent, $/PR,
heal-attempt average) plus the laggard project and the best-shipping
project this month - computed deterministically from existing telemetry
with no LLM call, so that opening the portal on month-start becomes a
reflection ritual the operator would not skip.

## Why now (four lenses)

### Product Owner

Today's home-page cards rhythm the operator's attention at progressively
slower cadences: 0033 is DAILY ("what happened yesterday"), 0037 +
0038 are WEEKLY ("what happened last week" + "what's queued for this
week"), 0059 is WEEKLY ("biggest surprise"). The MONTHLY cadence is
absent - the operator has no surface that compares June to May, May to
April. 0041 /receipts is the PUBLIC monthly artifact (a stable share
URL) but the operator's HOME page doesn't surface the same comparison
inline. 0050 year-in-review is the ANNUAL retrospective but fires once
a year. The monthly gap is the most natural reflection cadence and
exists nowhere.

The smallest meaningful unit of value: ONE card on the home page that
ONLY APPEARS on the first weekday of each calendar month (Mon-Fri; if
the 1st is a weekend, the card appears on the following Monday). The
card composes five deterministic comparisons:

1. **PRs shipped delta**: this month's count vs last month's, with the
   absolute and percent delta ("12 PRs this month, up 33% from 9").
2. **Spend delta**: this month's $ spent vs last month's ("$48.21 this
   month, up 12% from $43.04").
3. **$/PR delta**: this month's cost-per-merged-PR vs last month's
   ("$4.02 per PR this month, down 17% from $4.84").
4. **Heal-attempt average delta**: this month's mean
   `pr.heal_attempts` over merged PRs vs last month's ("avg 0.4 healing
   attempts per PR this month, down from 0.9").
5. **Best & laggard**: the project with the BEST shipping delta this
   month vs trailing 3-month median (one sentence: "courtiq shipped
   2x its trailing baseline this month"); the project with the WORST
   delta (one sentence: "almanac shipped 0 this month after averaging
   3").

The card carries a single dismissable badge (per 0017 inbox
dismissal pattern) so the operator can hide it after reading; it
re-fires on the FIRST WEEKDAY of the NEXT calendar month with a
fresh comparison. Per LESSONS 2026-05-28 "re-fire-after-dismiss
needs an aging window, not a partial UNIQUE index" - the dismissal
is keyed by `(kind='monthly_retro', month_iso='2026-06')` so
dismissing June's card does NOT suppress July's card. Per LESSONS
2026-06-13 "per-candidate detection fixtures must also satisfy the
global empty-fleet gate" - the helper enforces a GLOBAL "fleet has
< 8 weeks of merged-PR data -> warming up" guard ahead of the
month-over-month logic; per-comparison test fixtures MUST seed
enough trailing data to clear that gate AND clear the per-
comparison threshold.

No new ingest path. No new LLM call. Pure composition over `pr`
(state, fetched_at, heal_attempts), `run` (cost_usd, started_at,
project_id), and `project` (slug) tables that 0033 / 0035 / 0041 /
0044 / 0050 already read.

PRODUCER-VS-SPEC NOTE: per LESSONS 2026-06-05 "groomer prose can
disagree with the schema" and 2026-06-10 "PRODUCER-VS-SPEC for
column-value casing" - the `pr.state` literal is `'MERGED'`
(upper) for the writer in `src/ingest/prs.ts`; `pr.heal_attempts`
is INTEGER per the existing ALTER TABLE (grep `src/db.ts` for the
column declaration before writing the SELECT). The grouping on
month uses `strftime('%Y-%m', date(...))` per the existing
month-rollup convention in `src/receipts.ts` (grep for the
existing pattern before authoring a new one). Per LESSONS
2026-06-07 "the `pr` table has no surrogate id" - any cache
invalidation tuple uses `(MAX(pr.fetched_at), COUNT(*))` over
`pr`, NEVER `MAX(id)`.

### Stakeholder

Widens the moat on the MONTHLY-REFLECTION axis where no existing
surface invests. 0033 / 0037 / 0038 / 0059 cover daily and weekly
cadences; 0050 covers annual; 0048 (per-project worth-it verdict)
covers a yearly trajectory but per-project, not fleet-level. The
monthly cadence is the natural retrospective ritual that boardroom
retros, fitness habits, and budget reviews all assume - the fleet
operator's equivalent is a card they see on the first weekday of
each month and read for 30 seconds.

Per the cross-fleet courtiq lesson "rituals that pace themselves
to the operator's calendar compound retention more than features
that just answer questions" (CROSS_LESSONS section courtiq Entries
2026-05-21 family on cadence-based surfaces), the monthly retro
card is exactly that ritual applied to fleet-control's natural
metric set. The operator who comes back on June 1, July 1, August 1
sees the same card shape with different numbers - month-over-month
becomes a story they remember.

The structural moat: the monthly comparison is impossible for any
tool that doesn't own a long-tail telemetry history. fleet-control
already INGESTS that history (the `pr` / `run` tables grow over
time, never truncate) so the month-over-month is a free-cost
operation. SaaS dashboards either truncate history (vendor lock-in)
or charge per-month-of-retention; fleet-control gives the full
history for free because it's local-only.

The screenshot worth sharing: a portal home page on July 1
showing "June: 32 PRs, $148 spent, $4.62 per PR. Up 12% from May."
- a verdict only fleet-control can author because no other tool
owns both the operator's cost telemetry AND the comparison
window.

Pairs with 0041 (receipts - the PUBLIC monthly artifact; this
card is the PRIVATE home-page sibling), 0050 (year-in-review -
slower-cadence sibling), 0033 / 0037 / 0038 / 0059 (faster-
cadence daily / weekly siblings), 0044 (spend-efficiency ranking -
the per-project laggard surface; this card aggregates to the
fleet level).

### User (operator on the first weekday of the month, 9am, on the
portal)

The operator opens the portal on June 1 at 9am. The home page has
its usual cards plus ONE new card titled "Monthly retro -
<previous-month> vs <month-before>" with the five comparisons in
plain English. The card sits ABOVE the existing inbox (0017) so it
catches the eye first. At 375px (phone) the card is single-column
with the five deltas stacked vertically. The dismissal button is
one-tap (`data-testid="monthly-retro-dismiss"`).

The card is GLANCEABLE: each delta is one sentence, one number,
one arrow direction. No charts (the existing 0028 burndown / 0031
sparkline already cover the chart need); the monthly retro is
narrative-shape. The card carries `data-testid="monthly-retro-
card"` for portal smoke tests.

Honest empty state: the card never fires when the fleet has < 8
weeks of merged-PR data (per LESSONS 2026-06-13 "per-candidate
detection fixtures must also satisfy the global empty-fleet
gate") - the home page just shows its usual cards without the
retro. When the fleet has 8+ weeks but only 1 calendar month of
data (no PRIOR month to compare against), the card renders
"first full month - we'll have a comparison next month" inside
the same dimensions; per CROSS_LESSONS section courtiq share-flow
authenticity 2026-05-25 family, the card NEVER lies up by showing
fabricated baseline numbers.

Per LESSONS 2026-06-11 "startServer() tests that mutate
`fleet-control.config.json` race against parallel test files;
expose a renderer-direct seam for branch tests" - every detection
branch (silent-laggard, percent-delta, warming-up, first-full-
month) is exercised through a `_renderMonthlyRetroCardForTests
(payload, opts?)` seam, NOT a cwd config mutation.

### Growth

The "show me" moment is the operator's screenshot on July 1 of
"June was the best month yet - 50% more PRs at the same spend" -
a verdict only the monthly comparison can author. Per the cross-
fleet courtiq lesson "the artifact the operator screenshots is
the artifact that pulls a friend into the tool" (CROSS_LESSONS
section courtiq Entries 2026-05-21 family on share-flow), the
monthly retro is exactly that shape - the natural calendar
boundary that the operator has a reason to share.

The card is private (home-page only) but the screenshot gesture
makes it semi-public. The operator pastes a screenshot of "May
vs April" on Twitter once; the screenshot's structural template
is fleet-control branded (header bar + card frame). Per the
cross-fleet courtiq lesson "the prospect's first impression of
your tool is most likely to be the impression LEFT BY A CURRENT
USER, not by you" (CROSS_LESSONS section courtiq Entries
2026-05-21 family), the screenshot is the high-trust acquisition
funnel.

Pairs with 0061 (OG image variants - if the operator pastes the
screenshot AND links /receipts, both the screenshot AND the
auto-rendered preview reinforce the brand), 0050 (year-in-review
- the annual sibling), 0041 (receipts - the public monthly
sibling - the operator's screenshot of the home-page card pairs
naturally with a link to /receipts).

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: per
LESSONS 2026-06-05 "groomer prose can disagree with the schema"
the implementing dev MUST grep `src/ingest/prs.ts` for the
`pr.state` literal casing ('open' lower; 'MERGED' upper per the
existing writer) BEFORE writing any SELECT. The
`pr.heal_attempts` column is INTEGER per the existing ALTER
TABLE - grep `src/db.ts` to confirm the declaration shape. The
month-grouping uses `strftime('%Y-%m', date(fetched_at))` per
the existing convention in `src/receipts.ts` (grep for the
exact strftime format string before authoring a new one). Per
LESSONS 2026-06-07 "the `pr` table has no surrogate id" - the
cache invalidation tuple uses `(MAX(pr.fetched_at), COUNT(*))`
over `pr`, NEVER `MAX(id)`. Per LESSONS 2026-06-13 "per-
candidate detection fixtures must also satisfy the global
empty-fleet gate" - every per-comparison fixture seeds enough
trailing data to clear BOTH the 8-week empty-fleet gate AND
the per-comparison threshold.

- [ ] `src/views.ts` (or a new `src/retro.ts`) exports
      `monthlyRetroCard(db, now)` returning `{ kind: 'card' |
      'warming-up' | 'first-full-month', payload?: ... }`. When
      the GLOBAL gate fires (< 8 distinct trailing weeks of
      merged-PR data), returns `{ kind: 'warming-up' }`. When
      the gate passes but the trailing month has < 1 prior full
      calendar month of data, returns `{ kind: 'first-full-
      month' }`. Otherwise returns `{ kind: 'card', payload:
      { prs_this_month, prs_last_month, prs_delta_pct,
      spend_this_month, spend_last_month, spend_delta_pct,
      cost_per_pr_this, cost_per_pr_last, cost_per_pr_delta_pct,
      heal_avg_this, heal_avg_last, best_project_sentence,
      laggard_project_sentence, month_iso } }`. Test: three
      fixtures (warming-up, first-full-month, full card) assert
      each kind fires.

- [ ] First-weekday gating: the home-page card is RENDERED only
      when the request's `now` falls on the first Monday-Friday
      of a calendar month. The helper exposes a
      `isMonthlyRetroDay(now)` pure-function gate that the
      home-page renderer calls. The card NEVER fires on day 2-31
      of a month (the operator dismisses it OR sees it once on
      day 1). Test: drive `isMonthlyRetroDay()` with five anchor
      `now` values: 2026-06-01 (Monday - fires), 2026-07-01
      (Wednesday - fires), 2026-08-01 (Saturday - does NOT fire),
      2026-08-03 (Monday - fires because Sat 8-01 + Sun 8-02 are
      weekend; the gate slides to the first weekday), 2026-08-04
      (Tuesday - does NOT fire). Assert the gate returns the
      expected boolean for each.

- [ ] PRs-shipped delta: a fixture seeds 9 merged PRs in May
      (fetched_at in 2026-05-XX) and 12 merged PRs in June
      (fetched_at in 2026-06-XX). With `now = 2026-07-01` the
      card renders `prs_this_month: 12`, `prs_last_month: 9`,
      `prs_delta_pct: +33`. The renderer prose: "12 PRs this
      month, up 33% from 9". Per LESSONS 2026-06-10 "PRODUCER-
      VS-SPEC for column-value casing" - the SELECT compares
      `pr.state = 'MERGED'` (upper). Test: seed the fixture,
      call the helper, assert the three numbers AND the
      rendered sentence.

- [ ] Spend / $-per-PR / heal-attempt deltas: same fixture
      pattern as above (seed cost rows via `run` table with
      anchor-derived timestamps per LESSONS 2026-05-29; seed
      `pr.heal_attempts` via direct INSERT). Asserts each
      delta computes correctly across month boundaries
      including the edge case where last month's denominator
      is zero (the helper renders "no comparison - last month
      had 0 PRs" rather than dividing by zero). Test: three
      sub-assertions (spend delta, $/PR delta, heal-avg
      delta) plus one denominator-zero edge case.

- [ ] Best & laggard project sentences: a fixture seeds three
      projects with different shipping shapes (courtiq:
      consistent baseline + 2x this month; almanac: consistent
      baseline + 0 this month; sportsiq: flat baseline).
      Asserts `best_project_sentence` names courtiq with the
      2x ratio; asserts `laggard_project_sentence` names
      almanac with the 0-vs-baseline framing. The helper picks
      the SINGLE best and SINGLE laggard (no ties broken via a
      stable order: slug-alphabetical) per LESSONS section
      "per-candidate detection fixtures must also satisfy the
      global empty-fleet gate" - the trailing-3-month baseline
      requires 3 prior calendar months of data per project; if
      a project has < 3 prior months, it's EXCLUDED from the
      best/laggard pool (the helper falls back to "newest
      project: <slug>" if neither pool has eligible
      members). Test: seed three projects per the shape; assert
      the two sentences name the expected slugs.

- [ ] Honest empty state - warming up: a fixture seeds only 4
      weeks of merged-PR data; calls the helper; asserts kind
      is `'warming-up'`. The renderer's prose for the
      warming-up branch is the same "fleet warming up - check
      back after 8 weeks of data" sentence the 0059 helper
      uses (consistent honest empty-state copy across cards).
      Test: per LESSONS 2026-06-13 "per-candidate detection
      fixtures must also satisfy the global empty-fleet gate" -
      the fixture seeds 4 weeks of data which satisfies NO per-
      candidate threshold but also fails the 8-week global
      gate. Assert the warming-up sentence renders, NOT a
      fabricated number.

- [ ] Honest empty state - first full month: a fixture seeds
      9 weeks of merged-PR data anchored so only ONE full
      calendar month exists (no PRIOR full month to compare).
      Calls the helper with `now = 2026-06-01`. Asserts kind
      is `'first-full-month'`. The renderer's prose: "first
      full month - we'll have a comparison next month". Per
      CROSS_LESSONS section courtiq share-flow authenticity
      2026-05-25 family - no fabricated zero-baseline numbers.

- [ ] Idempotency / dismissal: the card is dismissable via
      `POST /api/control/dismiss-monthly-retro` (existing
      `inbox_dismissal` table per 0017). The dismissal is
      keyed by `(kind='monthly_retro', month_iso='2026-06')`
      per LESSONS 2026-05-28 "re-fire-after-dismiss needs an
      aging window, not a partial UNIQUE index" - dismissing
      June's card does NOT suppress July's card. The home-
      page renderer LEFT JOINs `inbox_dismissal` and hides
      the card when the current month's dismissal row
      exists. Test: dismiss June's card; assert home-page
      renderer does NOT include the card for
      `now=2026-06-15`; assert the card RE-APPEARS for
      `now=2026-07-01`.

- [ ] Cache invalidation: the monthly retro payload is
      memoised behind `(MAX(pr.fetched_at), COUNT(*) over pr,
      MAX(run.started_at), COUNT(*) over run, current_
      month_iso)`. Per LESSONS 2026-06-07 "the `pr` table has
      no surrogate id" - uses `(MAX(fetched_at), COUNT(*))`
      NOT `MAX(id)`. Per LESSONS 2026-06-05 "break ingest<->
      server cache-invalidation cycles via a globalThis slot"
      - registers on `globalThis.__fleet_monthly_retro_
      invalidate__`. Per LESSONS section "in-process dedup
      sets need an explicit reset hook for tests", exports
      `_resetMonthlyRetroCacheForTests()` AND
      `_getMonthlyRetroCacheBuildsForTests()`. Per LESSONS
      section "expose a build counter for cache-hit tests" -
      test asserts the build counter goes up 1 then 0 across
      two same-tuple calls; the counter goes up again when a
      fresh PR row lands.

- [ ] Renderer-direct seam + portal integration: per LESSONS
      2026-06-11 "startServer() tests that mutate `fleet-
      control.config.json` race against parallel test files;
      expose a renderer-direct seam for branch tests" - every
      branch (card / warming-up / first-full-month / dismissed)
      is driven through a `_renderMonthlyRetroCardForTests
      (payload, opts?)` seam. The boot-path test stays
      valuable for the integration shape (home-page route
      contains the card on the first weekday; testid present;
      dismiss endpoint wired) but the BRANCH-shape tests
      drive the renderer directly. Per LESSONS 2026-06-12
      "greedy `[^>]+id=` regex over a `<h2 id="..." data-
      testid="...">"` - tests scrape the home-page response
      via the `data-testid="monthly-retro-card"` anchor, NOT
      via a greedy `id=` regex.

- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-
      string composition. The endpoint is NET-NEW (no JSON-
      shape break to any existing `/api/...` route). The
      home-page additions are conditional rendering only.
      Schema migration: NO new tables; the dismissal uses
      the existing `inbox_dismissal` table (kind=
      'monthly_retro'). Per LESSONS 2026-06-13 "function-
      import cycles aren't always cache-invalidation; the
      cheapest fix is sometimes a 6-line inline copy" - if
      the retro module would need to import a helper from
      `src/views.ts` AND `src/views.ts` already imports from
      the retro module, prefer a private inline copy over
      the cycle. The globalThis-slot pattern is for cache
      invalidation only.

## Out of scope

- A weekly retro card (different cadence; 0037 + 0038 already
  cover the weekly cadence).
- A quarterly retro card (a future follow-up if monthly proves
  the ritual; for v1 a single monthly card is enough).
- A multi-month line chart on the card (the existing 0028
  burndown / 0031 sparkline already cover that need; the retro
  is narrative-shape).
- A per-project monthly retro (the card is FLEET-level; per-
  project monthly comparison is duplicative of 0048 yearly
  trajectory).
- An auto-share-to-public surface (the card is private; the OG
  image surface per 0061 is the share story).
- A "ranked second-best" extension (the card names ONE best and
  ONE laggard; ranking the full pool is duplicative of 0044
  spend-efficiency).
- A budget-projection variant ("at this rate you'll spend $X by
  end of month"). 0028 burndown handles the projection shape.
- A non-deterministic LLM-summarised narrative. The card is
  pure-SQL composition; LLM-narrative violates the no-LLM-call
  posture.

## Engineering notes

- `src/views.ts` (or new `src/retro.ts`) - new helper
  `monthlyRetroCard(db, now)` that composes the five
  comparisons. Pure SQL against existing tables; no new schema.
  PRODUCER-VS-SPEC NOTE: grep `src/ingest/prs.ts` for
  `pr.state` literal casing ('open' lower, 'MERGED' upper) and
  `src/receipts.ts` for the existing `strftime('%Y-%m', ...)`
  month-grouping pattern BEFORE writing the SELECT.
- `src/views.ts` - new pure-function gate
  `isMonthlyRetroDay(now: Date): boolean` - returns true when
  the date is the first Monday-Friday of the calendar month
  (slides past weekends). The gate is its own export so the
  home-page renderer AND the test suite can both call it
  directly.
- `src/server.ts` - one new endpoint `POST /api/control/
  dismiss-monthly-retro` keyed by month_iso per LESSONS
  2026-05-28 "re-fire-after-dismiss needs an aging window".
  Per LESSONS 2026-06-05 "break ingest<->server cache-
  invalidation cycles via a globalThis slot" - the cache
  invalidation registers on `globalThis.__fleet_monthly_
  retro_invalidate__`.
- `web/app.js` - home-page renderer queries the new helper
  on mount; renders the card ONLY when `kind !== undefined`
  AND `isMonthlyRetroDay(now)` AND no dismissal exists for
  the current month_iso. Card carries `data-testid=
  "monthly-retro-card"` (per LESSONS 2026-06-12 "greedy
  `[^>]+id=` regex" anchor) and the dismiss button carries
  `data-testid="monthly-retro-dismiss"`.
- `web/style.css` - one selector group for the new card,
  reusing existing CSS variables for color and font; do NOT
  add new variables.
- `tests/monthly-retro.test.ts` (new) - one `test(...)` per
  AC checkbox. Per LESSONS 2026-05-29 "time-pinned tests
  must NOT derive seed timestamps from `new Date()`", every
  seed anchors to the pinned `now`. Per LESSONS 2026-06-13
  "per-candidate detection fixtures must also satisfy the
  global empty-fleet gate" - every per-comparison fixture
  seeds enough trailing data to clear BOTH the 8-week
  empty-fleet gate AND the per-comparison threshold.
- Schema migration: NO new tables. The dismissal uses the
  existing `inbox_dismissal` table with kind='monthly_retro'
  and payload_id=`<month_iso>`.
- No new runtime deps. Lean on `node:sqlite`, `node:http`,
  the standard library. Pairs with 0017 (inbox dismissal -
  the dismissal table source), 0033 / 0037 / 0038 / 0059
  (faster-cadence siblings), 0041 (receipts - public
  monthly sibling), 0050 (year-in-review - annual sibling),
  0061 (OG image - the public-share artifact paired with
  this private home-page card via the operator's screenshot
  gesture).

## Implementation log

- 2026-06-15: implementation-dev picked the ticket. Branch
  feat/0062-monthly-fleet-retro-card off origin/main. Read AGENTS.md,
  LESSONS, the ticket, and the closest sibling (0059 biggest-surprise).
  Producer-vs-spec audit: src/ingest/prs.ts:188 writes 'open' lower for
  open PRs and 'MERGED' upper for merged rows; src/db.ts:352 declares
  pr.heal_attempts INTEGER DEFAULT 0; src/receipts.ts:127-138 groups by
  month via lex-comparable monthStart/monthEnd ISO ranges over
  pr.fetched_at (not strftime). Reusing the receipts pattern. The
  existing /api/fleet/inbox/dismiss endpoint already supports
  inbox_dismissal writes for arbitrary kinds; per the AC we ALSO expose
  a dedicated POST /api/control/dismiss-monthly-retro route so the SPA
  has the documented endpoint shape and operators / future tests get a
  clear single chokepoint for this card. Plan: new src/retro.ts module
  (helper + isMonthlyRetroDay gate) imported by views.ts via a private
  re-export to keep the function-import cycle lesson in mind; route +
  cache + globalThis-slot invalidation in src/server.ts; renderer-
  direct seam + dismiss handler in web/app.js; one CSS selector group.

- 2026-06-15: shipped. src/retro.ts is the new pure-SQL helper
  (monthlyRetroCard, isMonthlyRetroDay, monthLabelFor) — no
  src/views.ts cycle, no runtime deps, plain double-quoted SQL per the
  2026-05-26 "no backticks inside template-literal SQL strings" lesson.
  The first-full-month discriminator landed on "is `thisMonth` the
  fleet's first month with >= 3 merged PRs?" — that pivot resolves the
  ambiguity between "first-full-month" and AC4's "card with zero-
  denominator" cleanly without conflicting with the 8-distinct-weeks
  global gate (which May alone can't reach because May only has ~5 ISO
  weeks; the gate sees lifetime distinct weeks across all merged rows).
  src/server.ts hosts the 10-min memo cache keyed by (MAX(pr.fetched_at),
  COUNT(*) over pr, MAX(run.started_at), COUNT(*) over run, month_iso)
  per LESSONS 2026-06-07 (NEVER MAX(id) on the pr composite-PK table)
  plus the globalThis.__fleet_monthly_retro_invalidate__ slot per
  LESSONS 2026-06-05 read by src/ingest/index.ts. The
  POST /api/control/dismiss-monthly-retro endpoint sits BEFORE the
  /^\/api\/control\/([\w-]+)$/ verb dispatcher (which routes through
  doAction's KNOWN_ACTIONS shell-out surface) so a pure SQL INSERT
  doesn't get 400'd as an "unknown action" — same shape pattern as
  /api/fleet/inbox/dismiss. The renderer-direct seam
  (_renderMonthlyRetroCardForTests) gates dismissed / warming-up /
  first-full-month / card branches without booting startServer per
  LESSONS 2026-06-11. web/app.js mirrors the server-side renderer via
  renderMonthlyRetro + a sibling dismiss handler that POSTs to the new
  endpoint. web/style.css adds one .monthly-retro-card selector group
  reusing the existing accent / dim / ink / mono variables. The full
  test suite passes 1071/1126 — the 33 failures are pre-existing
  time-bombs (tests/digest.test.ts + tests/prs-merged.test.ts per
  LESSONS 2026-05-29 "time-pinned tests must NOT derive seed
  timestamps from new Date()") and parallel-test races (welcome*,
  demo, embed-pulse, etc.) — same 33 fail on pristine main. My 22
  new monthly-retro tests all pass.
