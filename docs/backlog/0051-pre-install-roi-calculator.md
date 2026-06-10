---
id: 0051
title: Pre-install ROI calculator — public /calculator page projects fleet-control's value before any install
status: proposed
priority: P1
area: portal
created: 2026-06-10
owner: gtm-innovation
---

## User story

As a prospective fleet operator who just read someone's fleet-control
receipts page on a thread, has not yet `git clone`d the repo, and
wants 30 seconds of "would this actually pay for myself" math
without installing anything, I want a single public page at
`/calculator` where I punch in (a) my GitHub username, (b) the
number of repos I would put on the loop, (c) my own hourly rate, and
get a deterministic, instant projection of "at the median fleet
this repo has seen, you would ship N PRs / month, spend $X, and the
ROI would be Yx your hourly rate", so that the decision to install
is one tap, not a half-day research project.

## Why now (four lenses)

### Product Owner

0046 (onboard wizard), 0025 (demo), and 0041 (receipts) cover the
post-install acquisition arc. 0044 (spend efficiency) and 0048
(worth-it verdict) answer the same question post-install. The pre-
install gap is the largest single drop-off in the funnel: a
prospective operator reads the receipts page, decides "neat", and
closes the tab because the next step ("clone the repo, configure
TCC, install launchd") is steep. The smallest meaningful unit of
value: ONE public page that does the same math the worth-it verdict
does, but against the prospect's own (very limited) inputs and the
median-fleet numbers fleet-control already knows from its own
ingested data. The page is a SINGLE HTML document with no JS state
beyond a form; the result is deterministic given the inputs. No new
schema, no new ingest path, no auth surface (the page is fully
public — it reveals only aggregated median statistics, never
per-project rows).

### Stakeholder

Widens the moat on the ACQUISITION axis where 0041 receipts and 0046
onboard already invest. Per the cross-fleet courtiq lesson "the
share-worthy moment is the verdict the tool can compute and the
prospect cannot" (CROSS_LESSONS § courtiq Entries, 2026-05-25 family),
the calculator is the exact same verdict-shape applied PRE-install:
a prospect with just three inputs sees a number their spreadsheet
can't generate (because they don't have the median fleet's PR
throughput and cost-per-PR — fleet-control's own SQLite does). This
is structurally impossible for every other tool: GitHub-native has
no cost data; Anthropic console has no PR data; a spreadsheet has
neither. The screenshot worth sharing: "punch in your username,
get a projected ROI" — the same shape as the year-in-review hero,
but applied to a future the prospect is choosing into. Pairs with
0050 year-in-review: 0050 is "what was it worth this year," 0051 is
"what could it be worth next year." Together they bookend the
adoption arc.

### User (prospect on a phone, 30 seconds, hasn't installed anything)

The page is one short single-column form. Three inputs: a GitHub
username (text), an integer "number of repos you'd put on the loop"
(default 3), a dollar hourly rate (default 75). One "calculate"
button. Below the button: a result block that renders the same
shape as a worth-it verdict card from 0048 — projected merged PRs /
month, projected spend / month, projected $/PR, projected ROI
multiplier — plus a small explanatory paragraph ("based on the
median project in this fleet-control instance, which sees ~21 merged
PRs / month at $2.10 / PR"). The result block is renderable from
the URL alone (the form submits as a GET to `/calculator?u=<user>
&n=<repos>&r=<rate>`) so a prospect can be sent the link with their
inputs prefilled. The page is mobile-first (375px viewport, no
horizontal scroll, large tap targets) because the receipts page that
links here is mobile-first too. The result is conservative: the
"projected merged PRs / month" is the 25th-percentile project in
the fleet, NOT the median, so the calculator under-promises and the
real install over-delivers. The page closes with a single CTA
button "install fleet-control" linking to a static `/install` route
that reuses the existing onboard wizard's first-screen copy.

### Growth

The "show me" moment that turns a thread reader into a clone: the
prospect types their GitHub handle and sees a number tied to their
own future. Pre-install conversion is the highest-leverage funnel
gap fleet-control has not yet addressed; 0041 receipts and 0046
onboard land BEFORE and AFTER this step but not at the moment of
"could this be for me?" Per the cross-fleet lesson "any acquisition
surface that requires install before showing value loses 90% of the
funnel" (CROSS_LESSONS § courtiq Entries, paraphrased from the
2026-05-21 family on observer-page conversion), the calculator
inverts the order: show the value FIRST, install SECOND. The
calculator page can be linked from any external thread / blog post
/ tweet with the prospect's inputs prefilled, and the result is the
opinionated verdict.

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: the
spec names `pr.state = 'MERGED'` and `pr.is_agent = 1` literally;
per LESSONS 2026-06-05 "groomer prose can disagree with the schema;
the schema wins" the implementing dev MUST grep `src/ingest/prs.ts`
for the producer's casing before writing the median SELECT. The
`is_agent` flag also has a producer-side definition; reuse the same
predicate the existing 0044 `spendEfficiencyRanking` and 0048
`projectWorthItVerdict` helpers use rather than reinventing it.

- [ ] `src/views.ts` exports `fleetMedianProjection(db: DB, now:
      Date = new Date(), opts?: {windowDays?: number, percentile?:
      "p25" | "median"}): FleetMedianProjection` returning
      `{window_days: number, projects_observed: number,
      merged_prs_per_month: number, spend_usd_per_month: number,
      cost_per_pr_usd: number | null, percentile: "p25" |
      "median", generated_at: string}`. The merged-PRs and spend
      values are computed PER PROJECT over the window
      (default 90 days) then aggregated to either the 25th
      percentile or the median across projects (default `p25` —
      the calculator is conservative). Projects with fewer than 3
      merged PRs in the window are excluded from the percentile
      computation (matches the 0048 `insufficient_data` floor).
      When fewer than 2 projects qualify, the helper returns
      `merged_prs_per_month: 0`, `spend_usd_per_month: 0`,
      `cost_per_pr_usd: null`, and `projects_observed:
      <whatever>` so the caller can render an "insufficient fleet
      data" message. Per LESSONS § "node:sqlite's .all() needs
      `as unknown as T[]`", every row narrowing uses the double
      cast. Per LESSONS § "time-pinned tests must NOT derive seed
      timestamps from `new Date()`", every seed anchors to the
      pinned `now`. Test: seed 5 projects with 10/15/21/30/45
      PRs/month, assert `p25 ≈ 15` (matches the conservative
      contract); seed only 1 qualifying project, assert
      `merged_prs_per_month === 0` and `cost_per_pr_usd ===
      null`.
- [ ] `computeRoiProjection(median: FleetMedianProjection, inputs:
      {repos: number, hourlyRateUsd: number, hoursPerPr?:
      number}): RoiProjection` returning `{projected_merged_prs:
      number, projected_spend_usd: number, projected_cost_per_pr_
      usd: number | null, human_equivalent_cost_usd: number,
      roi_multiplier: number | null, percentile_label: string}`.
      The projection multiplies the per-project median by
      `inputs.repos`. `hoursPerPr` defaults to 1 (matches 0048).
      `roi_multiplier = (projected_merged_prs * hoursPerPr *
      hourlyRateUsd) / projected_spend_usd` (null when spend is
      zero). The `percentile_label` is "conservative (25th
      percentile of fleet)" for the default. Test: median = 15
      PRs/mo @ $2.10/PR, repos = 3, rate = 100 → projected_
      merged_prs = 45, projected_spend = $94.50, human_equiv =
      $4500, roi ≈ 47.6x. Verify the arithmetic; adjust the
      illustration in the user-story prose if the test reveals a
      mismatch (the prose is illustrative; the test arithmetic is
      load-bearing per the 0048 precedent).
- [ ] `GET /api/fleet/median-projection` returns the AC1 shape as
      JSON. NO auth required (this is the public-facing pre-
      install surface). The response is the AGGREGATED median /
      p25 only — never per-project rows, never project names,
      never any data that could be used to deanonymise a fleet.
      Per LESSONS § "defence-in-depth secret redaction at the
      renderer boundary", the response passes through
      `redactSecrets` before `res.end`. Test: hit without any
      auth header, assert 200 with the aggregated shape; assert
      no `project_slug`, no `project_name`, no `is_agent` field
      appears in the response.
- [ ] `GET /calculator` renders a self-contained single-column
      HTML page (NO external JS, NO bundled SPA route — pure
      HTML form). Inline `<style>` block reuses the receipts
      page's structural CSS as precedent. The form has three
      `<input>` fields with `data-testid="calculator-username"`,
      `data-testid="calculator-repos"`,
      `data-testid="calculator-rate"`. The submit button carries
      `data-testid="calculator-submit"`. The form's `action`
      is `/calculator` and `method="GET"` so the result is
      bookmarkable. When the URL has query params, the page
      pre-fills the form AND renders the result block
      `data-testid="calculator-result"` below the form with the
      `RoiProjection` shape from AC2 inline. The page closes
      with a CTA button `data-testid="calculator-install-cta"`
      linking to `/install` (a follow-up route — for v1 this
      links to `https://github.com/<repo>` directly; the
      `/install` static page is out of scope). Per LESSONS §
      "defence-in-depth secret redaction at the renderer
      boundary", the rendered HTML passes through `redactSecrets`
      before `res.end`. Test: hit `/calculator` without query
      params, assert the form is present and no result block;
      hit with `?u=foo&n=3&r=100`, assert the form is prefilled
      and the result block carries the projected numbers.
- [ ] Input validation: `repos` is clamped to `[1, 20]` (1 is
      the minimum sane fleet, 20 prevents a denial-of-service via
      a huge integer); `hourlyRateUsd` is clamped to `[1, 1000]`
      (positive rate, sane upper bound). `username` is validated
      to match GitHub's username rules (`^[A-Za-z0-9-]{1,39}$`)
      but is COSMETIC — the calculator does NOT call the GitHub
      API to look the user up; the username is only used as a
      personalisation prefix in the result block ("foo, here's
      your projection"). When validation fails the page renders
      with `data-testid="calculator-error"` and the form retains
      the offending input value. Test: submit `?n=999`, assert
      the result clamps to 20; submit `?r=-5`, assert the form
      shows an error; submit `?u=foo bar`, assert the form shows
      an error.
- [ ] Caching: the `/calculator` HTML page itself sets
      `Cache-Control: max-age=300` (5 min — the median
      projection moves slowly and the form is static). The
      `/api/fleet/median-projection` JSON response sets
      `Cache-Control: max-age=900` (15 min — same window as
      0044). The page's median memoises per `(MAX(pr.fetched_at),
      COUNT(*), MAX(run.ended_at))`. Per LESSONS 2026-06-07 "the
      `pr` table has no surrogate `id`; proxy 'latest landed'
      via (MAX(fetched_at), COUNT(*))", the PR signal MUST use
      `(MAX(pr.fetched_at), COUNT(*))`, NEVER `MAX(pr.id)`. Per
      LESSONS § "in-process dedup sets need an explicit reset
      hook for tests", expose
      `_resetMedianProjectionCacheForTests()` AND
      `_getMedianProjectionCacheBuildsForTests()` per LESSONS §
      "expose a build counter for cache-hit tests, not a fetcher
      swap". Test: two calls within 15 min assert one build;
      seed a new PR, assert the next call rebuilds.
- [ ] Empty-fleet behaviour: when fewer than 2 projects qualify,
      the result block renders an honest "this fleet is too small
      to compute a median yet — try the demo at `/demo` for
      seeded numbers" message linking to the 0025 demo surface.
      The form remains usable. Test: render `/calculator?u=foo&
      n=3&r=100` against a freshly-initialised DB, assert the
      empty-fleet message is present and no broken numeric
      result appears.
- [ ] Mobile (per 0011): at 375px viewport the form stacks
      vertically, the inputs and button are full-width with at
      least 44px tap height, and the result block renders below
      with no horizontal scroll. Test: assert the existing
      mobile-portal text-level CSS contract at 375px and 768px
      viewport widths.
- [ ] Defensive privacy: the response NEVER includes any per-
      project identifying data. Static test asserts: grep the
      `/api/fleet/median-projection` response body for the
      literal strings `"project_slug"`, `"project_name"`,
      `"slug":`, `"name":` and assert none appear. Per LESSONS §
      "'no shell-string exec' static checks should grep the
      import, not the call site", this static check greps the
      RESPONSE STRING — the leak chokepoint, not the call site.
      Test: seed 5 named projects, hit the route, assert none of
      the seed's project slugs appears in the response.
- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-string
      composition. No JSON-shape break to any existing
      `/api/...` route (the route is net-new). The `/calculator`
      HTML page is public-readable like `/receipts/<slug>/<YYYY-
      MM>` per the 0041 precedent. No schema migration —
      composes existing `pr`, `cost_rollup_day`, `run`,
      `project` tables. Per LESSONS § "no backticks inside
      template-literal SQL strings", identifiers stay plain
      words. Per LESSONS § "julianday() drifts ~10us per
      timestamp", any 90-day window timestamp diff uses
      `strftime` decomposition.

## Out of scope

- Calling the GitHub API to look up the user's repos and pre-
  fill the projection. v1 takes the count as user input; auto-
  detection is a follow-up. Calling GitHub from a public route
  also introduces a rate-limit dependency the zero-runtime-dep
  contract should not assume.
- An LLM-authored personalised projection paragraph. The result
  prose is fixed-template; the verdict is deterministic.
- An "embed this calculator on your blog" iframe. The page is
  shareable via URL with prefilled query params (the natural
  embed shape); a true iframe widget is a follow-up if asked.
- Per-language / per-stack projections ("Rust projects ship 2x
  faster"). The median is fleet-wide; per-stack slicing requires
  classification data fleet-control does not currently ingest.
- A "compare to your current spend" mode where the prospect
  enters their current Claude bill. v1 is forward-projection
  only; "compare to current" is a follow-up.
- A multi-fleet / cross-operator median. Single-fleet by design
  (matches the rest of the surface).
- A signed / verifiable share link of the projection ("foo's
  fleet-control projection signed by fleet-control"). The
  calculator is inputs-only — there is nothing to verify.
- An ntfy push when the median changes meaningfully. Pull-only
  surface.

## Engineering notes

- `src/views.ts` — new `fleetMedianProjection(db, now, opts)`
  helper next to the existing `spendEfficiencyRanking` (line
  ~4247), `projectWorthItVerdict` (line ~5323). The per-project
  monthly throughput is the same primitive 0044 already computes;
  PRODUCER-VS-SPEC NOTE: grep `src/views.ts` for the EXACT
  exported helper before importing — 0044's helper may already
  expose the per-project breakdown that just needs aggregation
  here. The percentile computation is pure JS over the per-
  project array (no SQL `PERCENTILE_CONT` — node:sqlite does
  not ship it). Per LESSONS § "node:sqlite's .all() needs `as
  unknown as T[]`", every row narrowing uses the double cast.
- `src/views.ts` — new pure helper `computeRoiProjection
  (median, inputs)` (no DB dependency — pure arithmetic). This
  lives in `src/views.ts` next to the median helper for
  proximity but could just as well live in a new module; the
  dev picks. PRODUCER-VS-SPEC NOTE: the helper consumes the
  median helper's return shape — they MUST stay in lockstep.
- `src/server.ts` — two new handlers near the existing receipts
  routes (line ~2110): `GET /api/fleet/median-projection`
  (JSON, public — no auth scope) and `GET /calculator` (HTML,
  public). Per LESSONS 2026-06-05 "break ingest↔server cache-
  invalidation cycles via a globalThis slot", the calculator
  cache invalidation function MUST be registered on
  `globalThis.__fleet_median_projection_invalidate__` from
  `src/server.ts` and read lazily by `runIngestPass`. Per
  LESSONS § "route regex for 'owner/name' slugs needs an
  embedded slash", the `/calculator` route is a single path
  segment — the existing `[\w-]+` shape is fine.
- The query-string parser MUST use `URL`'s `searchParams` API
  (standard library) and validate every value via a typed
  `parseCalculatorParams(url: URL): {repos: number,
  hourlyRateUsd: number, username: string, errors: string[]}`
  helper. Per LESSONS § "route regex for 'owner/name' slugs
  needs an embedded slash" — separate the URL-shape regex from
  the value-validation logic so error messages stay precise.
  No shell-string composition (the `username` is rendered into
  HTML through `escapeHtml` — never concatenated into a SQL
  string or an `execFile` argv).
- `tests/calculator.test.ts` (new) — one `test(...)` per AC
  checkbox. Per LESSONS § "time-pinned tests must NOT derive
  seed timestamps from `new Date()`", every seed anchors to
  the test's pinned `now`. Per LESSONS § "in-process
  startServer() tests need an empty-roots config + run-row
  seeds", server-boot tests plant a tmp
  `fleet-control.config.json` in cwd and restore on cleanup.
  Per LESSONS § "anomaly tests need σ > 0 in the fixture",
  seed varied per-project throughput so the percentile
  computation is geometrically meaningful (not a flat
  baseline). Per LESSONS § "expose a build counter for cache-
  hit tests, not a fetcher swap", AC6 uses the build counter.
- Schema migration: NO new tables. Composes existing `pr`,
  `cost_rollup_day`, `run`, `project` tables.
- No new runtime deps. Pairs with 0025 (demo — the calculator's
  empty-fleet fallback links to the demo), 0041 (receipts —
  same self-contained public HTML page pattern), 0044 (spend-
  efficiency primitive provides the per-project monthly
  throughput), 0046 (onboard wizard — the install CTA lands
  here), 0048 (worth-it verdict — the projection re-uses the
  ROI shape), 0050 (year-in-review — the bookend pair: this is
  forward-projection, 0050 is retrospective).
