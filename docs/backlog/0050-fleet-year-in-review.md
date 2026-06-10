---
id: 0050
title: Fleet year-in-review — one shareable annual page only the local SQLite can author
status: proposed
priority: P1
area: portal
created: 2026-06-10
owner: gtm-innovation
---

## User story

As a solo operator who has been running fleet-control for ~12 months
and is wondering whether the whole experiment was worth it, I want a
single year-in-review page at `/year/<YYYY>` that names — in plain
prose plus a handful of numbers — how many PRs the fleet shipped, how
much I spent, what the fleet shipped that I'm proudest of, which
project did the most lifting, which cross-fleet lesson saved my hide
the most times, and the moment in the year I came closest to giving
up (the worst-week dip), so that I close the laptop on New Year's Eve
with a single artifact I can share or print that proves the year was
not a sunk cost.

## Why now (four lenses)

### Product Owner

0033 (yesterday glance), 0037 (Friday wrap), 0038 (Monday catch-up),
0043 (new-since-last-visit), and 0048 (worth-it verdict) already
cover the daily / weekly / quarterly retention surfaces. The year is
the only window the operator stops at and asks "was the whole thing
worth doing?" — and there is no fleet-control surface that answers
it. A year-in-review is the smallest meaningful unit of value that
removes that one yearly question from the operator's head. Subtraction
beats addition: the page composes already-shipped helpers
(`costPerMergedPr`, `fleetLeaderboard`, `lessonCreditRollup`,
`fleetStreak`, `projectWorthItVerdict` from 0048, `fleetChangelog`)
into a single read against a year-long window. No new schema, no new
ingest path, no new control surface. The page is a single GET that
renders a single HTML document; the URL is bookmarkable and
shareable.

### Stakeholder

Widens the moat on the only axis structurally impossible for every
other tool: **historical depth**. GitHub-native dashboards expire
their PR data behind paywalls past the search-index horizon (the
default search is ~12 months and the older PRs surface as redirects);
Anthropic's console shows ~30-day rolling cost; an operator's
spreadsheet has no PR or lesson data. Only fleet-control's local
SQLite has BOTH the full PR history AND the full cost history AND the
full lesson-credit ledger AND the cross-fleet lessons attribution AND
the streak data, all reconciled into one local file. Per the
courtiq cross-fleet lesson "the share-worthy moment is the opinionated
verdict only the tool can compute" (CROSS_LESSONS § 0048 stakeholder),
the year-in-review is the year-scale instance of that shape — the
exact kind of artifact a prospective adopter sees and goes "I want
the version of that for MY year." The screenshot worth sharing: the
top-of-page hero "in 2026 the fleet shipped 312 PRs at $4.20 / PR
across 6 projects, paying for itself 3.4x over."

### User (operator at 9pm on New Year's Eve, on the couch)

The page is one long single-column scroll. Top hero block: the
headline number ("312 PRs · $1,310 spent · 3.4x ROI"), the date
range, the project count. Below it: a single sparkline of merged PRs
per week through the year, with the worst week (most red PRs, fewest
merges) circled in red and labelled "the dip — week of <date>". Below
that: three project tiles ranked by merged-PR throughput, each with
its 12-month run-rate, its $/PR, its sticky verdict from 0048. Below
that: the top three cross-fleet lessons by heal-credit count, each
with the date authored, the project it was authored against, and the
total saved-PR count. Below that: one paragraph of plain prose
("Almanac shipped 92 PRs at $2.10/PR — its run-rate halved in Q3
when the budget cap landed (ticket 0021), and it has been
net-positive every week since.") composed from a small template per
project. Footer: a single button "copy share link". The page works
on a phone (375px, one column, no horizontal scroll). The page works
offline against the cached share (PWA, per 0029) so an operator on a
flight at year-end can still pull it up.

### Growth

The screenshot worth sharing is structurally different from anything
0041 receipts publishes: receipts are a one-month artifact, this is
a one-year artifact, and a year is the unit prospective operators
actually evaluate against ("did this thing earn its keep over the
course of an entire year"). The "show me" moment: post the hero line
+ the dip callout on a thread and let the reader project their own
fleet onto it. The natural follow-up: the prospective operator
clones, runs `fleetctl serve`, navigates to `/year/2026`, sees their
own (smaller, sparser) version of the same artifact, and that becomes
the moment they decide to keep going. Pairs with the 0051 calculator
(also in this batch): the calculator is "what could this be worth";
the year-in-review is "what was it actually worth". Together they
bookend the operator's adoption arc.

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: this
spec names `pr.state = 'MERGED'` (uppercase) and `pr.state = 'open'`
(lowercase) following the existing 0040 / 0044 / 0047 / 0048
reconciliation — but per LESSONS 2026-06-05 "groomer prose can
disagree with the schema; the schema wins" the implementing dev MUST
grep `src/ingest/prs.ts` for the literal value the producer writes
before composing each SELECT. The producer's casing is the contract.

- [ ] `src/views.ts` exports `fleetYearInReview(db: DB, year: number,
      now: Date = new Date(), opts?: {hourlyRateUsd?: number,
      hoursPerPr?: number}): FleetYearInReview` returning
      `{year: number, range_start: string, range_end: string,
      total_merged_prs: number, total_spend_usd: number,
      cost_per_pr_usd: number | null, roi_multiplier: number | null,
      project_count: number, weekly_merges: Array<{week_iso:
      string, merged: number, closed_unmerged: number, spend_usd:
      number}>, dip_week: {week_iso: string, merged: number,
      closed_unmerged: number, spend_usd: number, headline: string}
      | null, top_projects: Array<{project_slug: string,
      merged_prs: number, spend_usd: number, cost_per_pr_usd:
      number | null, verdict: "net_positive" | "watch" |
      "sunset_candidate" | "insufficient_data", prose: string}>,
      top_lessons: Array<{lesson_slug: string, lesson_date:
      string, lesson_title: string, heal_count: number,
      first_credited_at: string, last_credited_at: string,
      saved_pr_count: number}>, generated_at: string}`. The
      `weekly_merges` array spans every ISO week start that
      intersects `[year-01-01, year-12-31]`. The `dip_week` is the
      single ISO week with the highest `closed_unmerged - merged`
      delta — when no week shows a negative delta the dip is null
      ("a clean year"). The `top_projects` array is at most 3
      entries, sorted by `merged_prs` desc. The `top_lessons` array
      is at most 3 entries, sorted by `heal_count` desc — composed
      from `lessonCreditRollup(db, {window_days: 365})` filtered to
      the year. The `prose` per project is a fixed-template
      composition ("Almanac shipped 92 PRs at $2.10/PR. Verdict
      net-positive."), NOT an LLM call. Per LESSONS § "node:sqlite's
      .all() needs `as unknown as T[]`", every row narrowing uses
      the double cast. Per LESSONS § "time-pinned tests must NOT
      derive seed timestamps from `new Date()`", every seed anchors
      to the pinned `now`. Test: seed 312 merged PRs / $1,310 spent
      across 6 projects in 2026, assert the hero fields equal the
      seeded totals and `roi_multiplier ≈ 17.85` at default rate
      (312 * 1 * 75 / 1310). Adjust seed if arithmetic diverges
      (the test arithmetic is load-bearing per the 0048 precedent).
- [ ] Dip-week detection: when the year has a week where
      `closed_unmerged > merged` AND the spend that week is above
      the year median, the `dip_week.headline` reads "the dip —
      <N> PRs died, <M> merged, $<X> spent." When no week qualifies
      (either no losing week OR the losing week's spend is below the
      year median) `dip_week` is null. Per LESSONS § "anomaly tests
      need σ > 0 in the fixture", the test seeds varied weekly
      throughput so the median is meaningfully placed (not flat).
      Test: seed a year with one losing high-spend week, assert
      `dip_week` names that week's iso start; seed a year with all
      winning weeks, assert `dip_week === null`.
- [ ] `GET /api/fleet/year/:year` returns the AC1 shape as JSON.
      Requires `read` scope. The `:year` route segment is a 4-digit
      integer; non-matching shapes return 404 with a clear "year not
      found" body. Years before the earliest `run.started_at` or
      `pr.fetched_at` return 200 with empty arrays and
      `total_merged_prs: 0` (not a 404 — a year with no data is a
      legitimate question with a legitimate answer). Years more than
      one calendar-year in the future return 400 "year out of range".
      Test: hit without auth → 401; hit with `read` for a seeded
      year → 200 with the shape; hit with a future year → 400; hit
      with an empty year → 200 with zero totals.
- [ ] `GET /year/:year` renders a self-contained single-column HTML
      page (NO external JS, NO bundled SPA route). Inline `<style>`
      block reuses the existing receipts page's structural CSS as
      precedent — grep `src/server.ts` line ~2110 for the receipts
      page render path. Container `data-testid="year-in-review"`.
      Hero block `data-testid="year-hero"` with the three headline
      numbers. Sparkline block `data-testid="year-sparkline"` —
      pure SVG, 52 vertical bars (one per ISO week), the dip week
      bar carries `data-testid="dip-week"` and a red fill. Top-
      projects block `data-testid="top-projects"` with three child
      `data-testid="top-project-<slug>"` cards. Top-lessons block
      `data-testid="top-lessons"` with three child
      `data-testid="top-lesson-<lesson_slug>"` cards. Footer with
      `data-testid="copy-share-link"` button. Per LESSONS §
      "defence-in-depth secret redaction at the renderer boundary",
      the rendered HTML passes through `redactSecrets` before
      `res.end`. Test: render a seeded year, assert all six testids
      are present and the SVG has 52 `<rect>` children.
- [ ] Caching: the GET responses (`/api/fleet/year/:year` AND the
      HTML page) set `Cache-Control: max-age=3600` (1 hour — a
      year-in-review moves slowly). The renderer memoises per
      `year` keyed by tuple `(year, MAX(pr.fetched_at), COUNT(*)
      FROM pr WHERE state IN ('MERGED','open','CLOSED'),
      MAX(run.ended_at), COUNT(*) FROM run)`. Per LESSONS 2026-06-07
      "the `pr` table has no surrogate `id`; proxy 'latest landed'
      via (MAX(fetched_at), COUNT(*))", the PR signal MUST use
      `(MAX(pr.fetched_at), COUNT(*))`, NEVER `MAX(pr.id)`. Per
      LESSONS § "in-process dedup sets need an explicit reset hook
      for tests", expose `_resetYearInReviewCacheForTests()` AND
      `_getYearInReviewCacheBuildsForTests()` (the build-counter
      pattern per LESSONS § "expose a build counter for cache-hit
      tests, not a fetcher swap"). Test: two calls within the TTL
      assert one build; insert a PR fetched_at advance, assert the
      next call rebuilds.
- [ ] Empty-fleet behaviour: a year with zero ingested projects
      renders a single sentence "Nothing shipped in <year>. Run
      `fleetctl onboard` to register your first project." (links to
      the 0046 onboard wizard surface). `top_projects` and
      `top_lessons` render as empty `<ul>` containers with the
      message inside. Test: render a freshly-initialised DB at
      `/year/2026`, assert the empty-fleet sentence is present and
      no broken `top-project-` testid appears.
- [ ] PWA / offline integration (per 0029): the `/year/<YYYY>` HTML
      page is cached by the service worker for at least 14 days
      after first fetch. When the network is offline, the cached
      page renders with a `data-testid="stale-banner"` line "this
      year-in-review was generated <N> hours ago; reconnect to
      refresh." Test: prime the SW cache, simulate offline,
      navigate to `/year/2026`, assert the stale banner is visible
      and the hero numbers still render.
- [ ] Mobile (per 0011): at 375px viewport the hero stacks
      vertically, the sparkline scales to viewport width with no
      horizontal scroll, the top-projects and top-lessons cards
      stack one-per-row. At >=900px the hero shows the three
      numbers inline and the top-projects render as a 3-column
      grid. Test: assert the existing mobile-portal text-level CSS
      contract at 375px and 900px viewport widths.
- [ ] Quiet-hours integration (per 0030): when `quietHoursActive`
      is `true`, the dip-week SVG bar still renders but the
      explanatory red headline "the dip — N PRs died" is suppressed
      and replaced with a neutral "the lowest week of the year"
      label (no loss-framing language at 1am). The numbers
      themselves remain visible. Matches the 0048 precedent:
      information visible, prompts (and loss framing) suppressed.
      Test: stub quiet hours active, assert the headline label is
      the neutral form; stub inactive, assert the loss-framing
      headline.
- [ ] Performance: `fleetYearInReview(db, 2026, now)` against a
      seeded year of 312 PRs / 6 projects / 5,000 runs completes
      in under 200ms (cache miss) and under 5ms (cache hit). Per
      LESSONS § "in-process startServer() tests need an empty-roots
      config + run-row seeds", server-boot tests plant a tmp
      `fleet-control.config.json` in cwd and restore on cleanup.
      Per LESSONS § "julianday() drifts ~10us per timestamp", any
      week-boundary timestamp diff uses `strftime` decomposition.
      Test: seed the dataset, time both paths, assert thresholds
      (skip when `process.env.PERF !== "1"`).
- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-string
      composition. No JSON-shape break to any existing `/api/...`
      route (the route is net-new). No schema migration — composes
      `pr`, `run`, `cost_rollup_day`, `lesson_credit`, `project`,
      and reuses the existing helpers per Engineering notes. Per
      LESSONS § "no backticks inside template-literal SQL strings",
      identifiers stay plain words.

## Out of scope

- A monthly version of the same surface. Receipts (0041) already
  cover the month — the year is its own unit.
- A "year prediction" line ("on this trajectory you'll ship 400
  PRs in 2027"). Predictions invite endless caveats and the page
  is a RETROSPECTIVE.
- An LLM-authored narrative paragraph per project. The prose is
  fixed-template composition; mixing in an LLM breaks the zero-
  runtime-dep contract AND introduces nondeterminism into a page
  the operator may screenshot. The fixed-template prose stays.
- A multi-year comparison ("2026 vs 2025"). Single-year by design;
  comparisons can come later if asked.
- A per-project year-in-review (the moat is the FLEET-level
  composition; a per-project annual is just a 12-month receipts
  page).
- An ntfy push at year-end announcing the page is ready. The page
  is pull-only; pushing at year-end races the 0009 budget alerts
  and the 0027 correlation pushes.
- A public unauthenticated share link (per 0013 / 0041 the public
  share surface goes through `receipts_published`; the
  year-in-review v1 is loopback / token-gated like the rest of
  `/api/...`). A public share is a follow-up if asked.
- Cross-fleet (multi-operator) year-in-review. Single-fleet by
  design.

## Engineering notes

- `src/views.ts` — new `fleetYearInReview(db, year, now, opts)`
  helper next to the existing `fleetChangelog` (line ~3427),
  `lessonCreditRollup` (line ~4006), `projectWorthItVerdict`
  (line ~5323). REUSES the 0035 `costPerMergedPr`, 0026
  `fleetStreak`, 0042 `lessonCreditRollup`, 0048
  `projectWorthItVerdict`. PRODUCER-VS-SPEC NOTE: grep
  `src/views.ts` for the EXACT exported names before importing
  (helpers may have evolved). The weekly aggregation is a single
  SELECT against `pr WHERE project_id IN (...) AND state IN
  (<merged-casing>, <closed-casing>)` grouped by ISO week. Per
  LESSONS § "node:sqlite's .all() needs `as unknown as T[]`",
  every row narrowing uses the double cast.
- `src/server.ts` — two new handlers near the existing receipts
  routes (line ~2110): `GET /api/fleet/year/:year` (JSON, behind
  `read` scope) and `GET /year/:year` (HTML, public per the
  existing receipts page precedent at line ~2118). Per LESSONS
  2026-06-05 "break ingest↔server cache-invalidation cycles via a
  globalThis slot", the year-in-review cache invalidation
  function MUST be registered on
  `globalThis.__fleet_year_in_review_invalidate__` from
  `src/server.ts` and read lazily by `runIngestPass`. Per LESSONS
  § "route regex for 'owner/name' slugs needs an embedded slash",
  the `:year` capture is a single path segment so the existing
  `[\w-]+` shape is fine, but the year value is validated
  separately as a 4-digit integer in a `validateYearParams()`
  helper.
- `web/app.js` — add a hash route `#/year/<YYYY>` that just
  navigates to the server-rendered `/year/<YYYY>` page (the SPA
  does not own the year-in-review rendering — the page is
  self-contained HTML like receipts). The PWA service worker
  cache config (likely `web/sw.js`) needs the `/year/` URL added
  to the cached-route list per the 0029 contract.
- `tests/year-in-review.test.ts` (new) — one `test(...)` per AC
  checkbox. Per LESSONS § "time-pinned tests must NOT derive seed
  timestamps from `new Date()`", every seed anchors to the test's
  pinned `now`. Per LESSONS § "in-process startServer() tests
  need an empty-roots config + run-row seeds", server-boot tests
  plant a tmp `fleet-control.config.json` in cwd and restore on
  cleanup. Per LESSONS § "anomaly tests need σ > 0 in the
  fixture", seed varied weekly throughput so the dip detection's
  median comparison is meaningfully exercised. Per LESSONS §
  "expose a build counter for cache-hit tests, not a fetcher
  swap", AC4 uses the build counter.
- Schema migration: NO new tables. Composes existing `pr`,
  `run`, `cost_rollup_day`, `lesson_credit`, `project` tables
  plus the existing 0026 / 0035 / 0042 / 0048 helpers.
- No new runtime deps. Pairs with 0041 (receipts is the monthly
  artifact; this is the annual artifact), 0042 (lesson credit
  ledger is the data source for the top-lessons block), 0048
  (the per-project verdict is reused in the top-projects block),
  0029 (PWA offline shell), 0011 (mobile contract).
