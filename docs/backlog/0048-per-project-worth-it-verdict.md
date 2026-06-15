---
id: 0048
title: Per-project worth-it verdict - each project card emits a yearly-trajectory "keep, watch, or sunset" call
status: shipped
priority: P2
area: observability
created: 2026-06-09
owner: gtm-innovation
---

## User story

As a fleet operator at end-of-quarter looking at five project
cards and trying to decide "should I keep almanac on the loop
for another three months," I want each project card to carry a
one-line verdict that fuses the trailing 30-day run-rate
($/month), the merged-PR throughput (PRs/month), the merge
ratio (merged / closed), the streak score (per 0026), and a
fixed human-equivalent hourly constant into a single
"net positive," "watch," or "sunset candidate" verdict with
the supporting numbers - "almanac: $44/mo run-rate, 21 PRs/mo,
92% merge, 3.2x ROI of human equivalent. Verdict: net
positive." - so that the hardest decision in the operator's
month (which project to keep) becomes a glance instead of a
spreadsheet exercise.

## Why now (four lenses)

### Product Owner
0035 (cost per merged PR) tells the operator the unit
economics. 0022 (fleet temperature) tells them health. 0026
(streak heatmap) tells them consistency. 0044 (spend-
efficiency ranking) ranks projects against each other. None
of them answer the operator's actual quarter-end question:
"is this project WORTH the cost relative to me doing it
myself, and is the trajectory sustainable?" The verdict
composes the four existing primitives plus a single human-
equivalent hourly constant (configurable; defaults to a
sensible mid-market rate) into one of three labels per
project. Pure composition over already-shipped data - no
new schema, no new ingest path, no new control surface. The
smallest meaningful unit of value: ONE verdict per project
card, with the supporting numbers shown inline so the
operator can audit the conclusion at a glance. The constant
is the ONLY new knob, and it lives in
`fleet-control.config.json` under one key.

### Stakeholder
Widens the moat on the DECISION-SUPPORT axis - the highest-
leverage retention surface fleet-control has not yet shipped.
The operator's churn risk is concentrated in the moment
they look at a project and think "I'm not sure this is
worth it anymore" with no surface to confirm or refute. A
deterministic verdict that names the trajectory makes
"sunset" an explicit, considered decision rather than a
drift. Per the cross-fleet courtiq lesson "the share-
worthy moment is the opinionated verdict only the tool can
compute," the fused signal (cost + throughput + merge
ratio + streak + human-equivalent constant) is the kind
of cross-axis composition only fleet-control's SQLite can
do - GitHub-native gives you PR throughput with no cost
context; Anthropic gives you cost with no PR context; a
spreadsheet gives you both but no streak/health context
and no auto-update. The structural impossibility for other
tools is what 0035 + 0022 + 0026 + 0044 already prove on
narrower axes; this ticket fuses them into the per-project
verdict. The screenshot worth sharing: a project card with
the "Verdict: net positive (3.2x ROI)" line - one
sentence that a prospective adopter recognises as "the
question my own fleet can't answer."

### User (operator end-of-quarter, looking at the home grid)
On the home page project grid, every project card grows ONE
new line at the bottom of its body (BELOW the existing 0022
temperature, 0026 streak, 0035 cost-per-PR, and 0044 spend-
efficiency cross-link rows):

<!--
+----------------------------------------------------+
| almanac                              [fleet temp 7] |
| 21 PRs / 30d   92% merge   streak 12d              |
| $44 / month    $2.10 / PR                          |
|                                                    |
| Verdict: net positive   (3.2x ROI of human equiv)  |
|   $44/mo vs ~$140/mo human equivalent at 1h/PR     |
+----------------------------------------------------+

+----------------------------------------------------+
| courtiq2                             [fleet temp 4] |
| 1 PR / 30d     50% merge   streak 0d               |
| $48 / month    $48 / PR                            |
|                                                    |
| Verdict: sunset candidate   (0.7x ROI)             |
|   $48/mo vs ~$33/mo human equivalent at 1h/PR      |
+----------------------------------------------------+
-->

The verdict line is THREE possible labels (`net positive`,
`watch`, `sunset candidate`) chosen via deterministic
thresholds (see AC2). The ROI number is the ratio of the
human-equivalent cost to the project's actual cost. The
sub-line shows the arithmetic so the operator can verify
("$X/mo vs ~$Y/mo at <Z>h/PR at $<rate>/hr"). When a
project has fewer than 3 merged PRs in the trailing 30
days, the verdict is `insufficient data` and the sub-line
reads "need 3+ merged PRs in 30 days to verdict"
(prevents misleading calls on stub projects). On phone,
the verdict line remains; the sub-line collapses behind
a tap-to-expand.

### Growth
The screenshot worth sharing: a project card with "Verdict:
net positive (3.2x ROI of human equivalent)" - the kind of
opinionated call that turns "the portal shows me numbers"
into "the portal tells me what to do with my projects." The
"show me" pitch: "fleet-control doesn't just show you costs
and PR counts - it tells you whether each project is paying
for itself versus you doing it by hand." More compelling
than 0035's $/PR alone because it answers the operator's
implicit question ("is this worth it"); more compelling
than 0044's laggard because it grades EVERY project, not
just the worst. Per the cross-fleet courtiq lesson "the
share-worthy moment is the verdict that closes a question
the operator was carrying," this is exactly that shape on
the keep/sunset axis.

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE:
when this spec names a column value literally (`pr.state =
'MERGED'`, `pr.state = 'CLOSED'`, `is_agent = 1`), the
implementing dev MUST grep `src/ingest/prs.ts` for the
producer's actual casing before writing the SELECT. Per
LESSONS 2026-06-05 "groomer prose can disagree with the
schema; the schema wins": the producer is the contract. The
0044 spec also names `state = 'MERGED'` but the producer
writes lowercase; ship discovered this. The implementing
dev MUST do the same audit BEFORE writing the SELECT.

- [ ] `src/views.ts` exports `projectWorthItVerdict(db,
      projectId: number, now: Date, opts?:
      {windowDays?: number, humanEquivalentHourlyUsd?:
      number, humanHoursPerPr?: number}):
      {project_slug: string, project_name: string,
      window_days: number, merged_prs: number,
      closed_prs: number, merge_ratio: number | null,
      spend_usd: number, monthly_runrate_usd: number,
      cost_per_pr_usd: number | null, streak_days:
      number, fleet_temp: number | null, human_
      equivalent_cost_usd: number, roi_multiplier:
      number | null, hourly_rate_usd: number,
      hours_per_pr: number, verdict: "net_positive"
      | "watch" | "sunset_candidate" | "insufficient_
      data", verdict_detail: string, generated_at:
      string}`. Reuses the existing `costPerMergedPr`
      helper for the cost + merged-PR primitives,
      0022's fleet-temperature helper for `fleet_
      temp`, and 0026's streak helper for `streak_
      days`. Computes `merge_ratio = merged_prs /
      (merged_prs + non_merged_closed_prs)` over the
      window (null when no closes). The `monthly_
      runrate_usd` is `spend_usd * (30 / window_
      days)` (normalises to a 30-day projection
      regardless of window length). The `human_
      equivalent_cost_usd` is `merged_prs *
      hours_per_pr * hourly_rate_usd`. The `roi_
      multiplier` is `human_equivalent_cost_usd /
      spend_usd` (null when `spend_usd === 0`).
      Defaults: `windowDays = 30`, `humanEquivalent
      HourlyUsd = 75` (mid-market US contractor
      rate, documented in the helper's JSDoc),
      `humanHoursPerPr = 1` (one engineer-hour per
      PR is a conservative midpoint per published
      industry benchmarks; the operator overrides
      via the config knob). Per LESSONS §
      "node:sqlite's .all() needs `as unknown as
      T[]`", every row narrowing uses the double-
      cast. Per LESSONS § "time-pinned tests must
      NOT derive seed timestamps from `new Date()`",
      every seed anchors to the pinned `now`. Test:
      seed a project with 21 merged PRs and $44
      spent over 30 days at default rate, assert
      `roi_multiplier ≈ 3.2` (21 * 1 * 75 / 44 =
      35.79 ... actually verify the seed produces
      the claimed ratio - if not, adjust the
      seed); seed a project with 1 merged PR and
      $48 spent, assert `roi_multiplier ≈ 1.56`
      (1 * 1 * 75 / 48). Adjust the user-story
      mock numbers in this ticket if the test
      reveals an arithmetic mismatch (the prose
      is illustrative, the test arithmetic is
      load-bearing).
- [ ] Verdict cascade (deterministic, top-down):
      1. **insufficient_data**: `merged_prs < 3`
         (need 3+ to compute a meaningful merge
         ratio and ROI). `verdict_detail` = "need
         3+ merged PRs in <window_days> days to
         verdict".
      2. **sunset_candidate**: `roi_multiplier < 1.0`
         (the project costs more than the human
         equivalent) OR (`merge_ratio < 0.5` AND
         `merged_prs < 5`) (most PRs die and
         throughput is low). `verdict_detail` =
         "$<runrate>/mo vs ~$<human>/mo human
         equivalent at <hours>h/PR" when the ROI
         is the trigger; "<merged>/<closed+merged>
         PRs merge; throughput low" when the merge
         ratio is the trigger.
      3. **watch**: `roi_multiplier >= 1.0 AND
         roi_multiplier < 2.0` OR `merge_ratio <
         0.7` OR `streak_days === 0` (any one of
         these conditions). `verdict_detail`
         names the WEAKEST signal first: "ROI <
         2x" / "merge ratio <70%" / "no merged
         PR today".
      4. **net_positive** (default): `roi_
         multiplier >= 2.0 AND merge_ratio >=
         0.7 AND streak_days > 0`. `verdict_
         detail` = "$<runrate>/mo vs ~$<human>/
         mo human equivalent at <hours>h/PR".
      Per LESSONS § "anomaly tests need
      sigma > 0 in the fixture" - seed each
      verdict's defining condition with
      realistic surrounding signal so a
      wrongly-ordered cascade fails noisily.
      Test: for each verdict, seed exactly the
      matching condition, assert the verdict +
      verdict_detail substrings.
- [ ] Config knob: the `humanEquivalentHourly
      Usd` and `humanHoursPerPr` defaults come
      from `fleet-control.config.json` keys
      `worth_it.hourly_rate_usd` (default 75)
      and `worth_it.hours_per_pr` (default 1).
      PRODUCER-VS-SPEC NOTE: grep
      `src/config.ts` for the existing pattern
      for nested config keys before writing
      these (some configs use dots in keys,
      others use nested objects - reuse the
      existing shape). The helper accepts
      explicit `opts.humanEquivalentHourlyUsd`
      / `opts.humanHoursPerPr` for tests AND
      operators who want a per-call override
      without touching the config. Per LESSONS
      2026-05-25 "store cascading config
      values shaped to the reader" - the
      writer (any future portal-side setter)
      MUST write in the same shape the helper
      reads. v1 is config-file-only (no
      portal UI for setting these - see Out
      of scope). Test: set
      `worth_it.hourly_rate_usd: 100` in a
      tmp config, assert the verdict's
      `hourly_rate_usd === 100`; pass
      `opts.humanEquivalentHourlyUsd = 150`,
      assert it overrides the config; pass
      neither, assert the default 75.
- [ ] `GET /api/projects/:slug/worth-it`
      returns the shape from AC1. Requires
      `read` scope. The slug routing follows
      the existing per-project route pattern
      in `src/server.ts` (grep for an
      existing `/api/projects/:slug/...`
      route as precedent). Test: hit without
      auth -> 401; hit with `read` and a
      seeded project -> 200 with the shape;
      hit with an unknown slug -> 404 with
      a clear "project not found" body.
- [ ] Caching: response sets `Cache-Control:
      max-age=900` (15 min - the verdict
      moves slowly; same window as 0044). The
      handler memoises per-(project_slug,
      window_days, rate, hours) by tuple
      `(MAX(pr.fetched_at) WHERE project_id
      = ?, COUNT(*) WHERE project_id = ?,
      MAX(run.ended_at) WHERE project_id =
      ?)`. Per LESSONS 2026-06-07 "the `pr`
      table has no surrogate `id`; proxy
      'latest landed' via (MAX(fetched_at),
      COUNT(*))" - the PR signal MUST use
      `(MAX(pr.fetched_at), COUNT(*))`,
      NEVER `MAX(pr.id)`. Per LESSONS §
      "in-process dedup sets need an
      explicit reset hook for tests", expose
      `_resetWorthItCacheForTests()` AND
      `_getWorthItCacheBuildsForTests()` per
      LESSONS § "expose a build counter for
      cache-hit tests, not a fetcher swap".
      Test: two calls within 15 min assert
      one build; insert a new PR for the
      project, assert next call rebuilds.
- [ ] `web/app.js` renders the verdict line
      inside each existing project card body,
      BELOW the existing 0022 fleet-temp,
      0026 streak, 0035 cost-per-PR, and any
      0044 spend-efficiency cross-link rows.
      Container `data-testid="project-card-
      verdict-<slug>"`. Layout: one line
      "Verdict: <label> (<roi_multiplier>x
      ROI of human equivalent)" with the
      label color-coded (green for net_
      positive, yellow for watch, red for
      sunset_candidate, neutral for
      insufficient_data) and the ROI omitted
      when null/insufficient. One sub-line
      with `verdict_detail`. The sub-line
      uses smaller font (reuse existing
      smaller-text CSS class). When the
      verdict is `insufficient_data`, the
      sub-line is the explanatory message
      and no ROI is shown. Per LESSONS §
      "defence-in-depth secret redaction at
      the renderer boundary", every
      operator-visible string passes through
      `redactSecrets`. The verdict data is
      fetched LAZILY via the per-project
      route on card render (one fetch per
      card on the home page - the existing
      project-card render path is per-card,
      so a parallel fetch is natural). Test:
      stub one project per verdict, assert
      the DOM matches; stub `insufficient_
      data`, assert no ROI is rendered.
- [ ] Optional fleet endpoint for the home
      page: `GET /api/fleet/worth-it` returns
      `{projects: Array<<shape from AC1>>,
      generated_at: string}` so the home
      page can issue ONE fetch instead of N
      per-card fetches. The fleet endpoint
      reuses the same cache, keyed per-
      project. Test: hit the fleet endpoint
      with 3 seeded projects, assert all 3
      entries are present in the response;
      hit the per-project endpoint for one
      of them, assert the value matches
      what the fleet endpoint returned for
      that slug.
- [ ] Sunset-candidate visual treatment:
      project cards whose verdict is
      `sunset_candidate` for >= 14
      consecutive days (computed by
      comparing the verdict against the
      same project's verdict 14 days ago -
      requires running the helper twice with
      different `now` anchors) grow an
      additional `data-testid="sunset-
      sticky"` chip "sunset 14d+" near the
      verdict label. The two-anchor
      computation lives in a separate
      helper `projectWorthItSticky(db,
      projectId, now)` that returns
      `{verdict_now, verdict_14d_ago,
      sticky_days: number}` and short-
      circuits if either verdict is
      `insufficient_data`. Per LESSONS §
      "anomaly tests need sigma > 0 in the
      fixture" - the test seeds a 14-day
      historical fixture so the two-anchor
      computation has real data. Test: seed
      a project that has been `sunset_
      candidate` for 14+ days, assert the
      sticky chip is present; seed one
      that's `sunset_candidate` only for
      3 days, assert no chip.
- [ ] Mobile: at 375px viewport the
      verdict line remains visible at the
      bottom of each project card. The
      verdict_detail sub-line collapses
      behind a tap-to-expand chevron (the
      label + ROI stay visible). No
      horizontal scroll (per 0011
      conventions). At >=600px both lines
      render inline. Test: assert via the
      existing mobile-portal text-level
      CSS contract at 375px (sub-line
      hidden) and 600px (both lines
      visible).
- [ ] Quiet-hours integration: when 0030's
      `quietHoursActive` is `true`, the
      sunset-sticky chip (AC8) is hidden
      across all project cards (a
      midnight-portal-open should not
      surface a 14-day sunset prompt - the
      operator might react impulsively).
      The verdict line itself remains
      visible. Per the existing 0030
      pull-vs-push contract, this matches
      the 0044 / 0045 precedent:
      information visible, prompts
      suppressed. Test: stub quiet hours
      active + a sticky-sunset project,
      assert no `sunset-sticky` testid;
      stub inactive, assert it's present.
- [ ] Performance: `projectWorthItVerdict
      (db, projectId, now)` for a single
      project completes in under 20ms. The
      fleet endpoint with 50 projects
      completes in under 200ms (cache
      miss) and under 5ms (cache hit). Per
      LESSONS § "in-process startServer()
      tests need an empty-roots config +
      run-row seeds", server-boot tests
      plant a tmp `fleet-control.config.
      json` in cwd and restore on cleanup.
      Test: seed the dataset, time both,
      assert thresholds (skip if `process.
      env.PERF !== "1"`).
- [ ] No new runtime deps. `tsc --noEmit`
      clean. No shell-string composition.
      No JSON-shape break to any existing
      `/api/...` route - the two new
      routes (`/api/projects/:slug/worth-
      it` and `/api/fleet/worth-it`) are
      net-new; the home payload is
      unchanged; the project page payload
      is unchanged. No schema migration -
      composes existing `pr`, `cost_
      rollup_day`, `run`, `project`
      tables plus the existing 0022 / 0026
      / 0035 helpers. Per LESSONS § "no
      backticks inside template-literal
      SQL strings", identifiers stay
      plain. Per LESSONS § "julianday()
      drifts ~10us per timestamp", any
      timestamp diff uses strftime
      decomposition.

## Out of scope

- A portal UI for setting the `worth_it`
  config keys. v1 is config-file-only -
  the operator edits `fleet-control.
  config.json`. Portal UI is a follow-up
  if asked.
- An auto-pause action on sunset_
  candidate projects. The verdict is a
  SIGNAL surface; the action is the
  existing 0021 budget autopause or the
  per-project pause control. Mixing them
  weakens both - an automatic sunset
  decision is exactly the kind of
  irreversible bias this surface is
  meant to AVOID by being
  recommendation-only.
- LLM-authored verdict prose. The
  cascade is deterministic and the
  verdict_detail is composed from fixed
  templates so the surface stays
  runtime-free.
- A per-PHASE verdict (ship vs groom vs
  review). v1 is project-level; phase-
  level lives on the project page if
  ever needed.
- A historical trend of verdicts over
  time (a sparkline of "this project's
  verdict has been net_positive 12 of
  the last 14 weeks"). The sticky-
  sunset chip is the v1 trend surface;
  full trends live in the digest
  (0012).
- ML / weight-tuning for the verdict
  thresholds. The thresholds are
  deterministic and small enough to
  live in code; tuning knobs invite
  endless bikeshedding without operator
  value.
- An ntfy push when a project tips to
  sunset_candidate. The verdict is a
  pull surface; pushing would race the
  0009 budget alerts and the 0027
  cross-project correlation pushes.
- A receipts (0041) integration that
  publishes per-project verdicts. The
  verdict is INTROSPECTION; receipts
  are CELEBRATION. Mixing weakens both
  (same precedent as 0044's out-of-
  scope).
- A cross-fleet (multi-operator) worth-
  it surface. Single-fleet by design.
- Auto-archiving a project after N
  weeks of sunset_candidate. v1 is
  recommendation-only.

## Engineering notes

- `src/views.ts` - new
  `projectWorthItVerdict(db, projectId,
  now, opts)` helper next to the
  existing 0035 `costPerMergedPr` (line
  ~1875), 0044 `spendEfficiencyRanking`,
  0040 `riskiestOpenPr`. REUSES the 0035
  helper for cost + merged-PR
  primitives, the 0022 helper for
  fleet_temp, the 0026 helper for
  streak_days. PRODUCER-VS-SPEC NOTE:
  grep `src/views.ts` for the exact
  exported names of those three helpers
  before importing (they may have
  evolved since ticket landing). The
  merge-ratio query is a single SELECT
  against `pr WHERE project_id = ? AND
  (state IN (<merged-casing>, <closed-
  casing>)) AND <closed_at OR
  merged_at>-in-window`. Per LESSONS §
  "node:sqlite's .all() needs `as
  unknown as T[]`", every row narrowing
  uses the double-cast.
- `src/views.ts` - new
  `projectWorthItSticky(db, projectId,
  now)` helper that calls
  `projectWorthItVerdict` twice (now,
  now - 14 days) and returns the
  sticky_days. The 14-day-ago anchor
  uses the same 30-day rolling window
  computed from `(now - 14 days)`. Per
  LESSONS § "time-pinned tests must NOT
  derive seed timestamps from `new
  Date()`", the test's seed timestamps
  anchor to the pinned `now`.
- `src/config.ts` - extend the existing
  config loader to read the
  `worth_it.hourly_rate_usd` and
  `worth_it.hours_per_pr` keys with
  defaults 75 and 1. PRODUCER-VS-SPEC
  NOTE: grep for the existing nested-
  key pattern before writing.
- `src/server.ts` - two new routes:
  `GET /api/projects/:slug/worth-it`
  and `GET /api/fleet/worth-it`. Both
  reuse the existing `read` scope
  middleware. The cache invalidation
  tuple is per-project `(MAX(pr.
  fetched_at) WHERE project_id = ?,
  COUNT(*) WHERE project_id = ?,
  MAX(run.ended_at) WHERE project_id =
  ?)`. Per LESSONS 2026-06-07 "the
  `pr` table has no surrogate `id`;
  proxy 'latest landed' via
  (MAX(fetched_at), COUNT(*))" -
  NEVER use `MAX(pr.id)`. Per LESSONS
  § "expose a build counter for cache-
  hit tests, not a fetcher swap" -
  expose `_resetWorthItCacheForTests()`
  and `_getWorthItCacheBuildsForTests
  ()`. Per LESSONS 2026-06-05 "break
  ingest<->server cache-invalidation
  cycles via a globalThis slot" - if
  the ingest pass needs to bust this
  cache, register an invalidation
  function on `globalThis.__fleet_
  worth_it_invalidate__` from
  `src/server.ts` and have
  `runIngestPass` call it lazily.
- `web/app.js` - extend the existing
  project-card render helper to fetch
  the per-project verdict (or read
  from the fleet-wide payload if the
  home page made the bulk fetch) and
  append the verdict line at the
  bottom of each card body. The
  fleet-wide bulk fetch is the
  default home-page path; the per-
  project fetch is for the project
  page if/when added there
  (currently the verdict only
  renders on the home grid). Per
  LESSONS § "defence-in-depth secret
  redaction at the renderer
  boundary", every operator-visible
  string passes through
  `redactSecrets`.
- `web/style.css` - one selector
  group for the verdict line (label
  color chips - reuse existing CSS
  color variables, do NOT add new
  ones); one for the sub-line
  smaller font (reuse existing
  smaller-text class); one for the
  sunset-sticky chip; one for the
  mobile tap-to-expand chevron. NO
  new CSS variables.
- `tests/worth-it.test.ts` (new) -
  one `test(...)` per AC checkbox.
  Per LESSONS § "time-pinned tests
  must NOT derive seed timestamps
  from `new Date()`", every seed
  anchors to the test's pinned
  `now`. Per LESSONS § "in-process
  startServer() tests need an
  empty-roots config + run-row
  seeds", server-boot tests plant a
  tmp `fleet-control.config.json`
  in cwd and restore on cleanup.
  Per LESSONS § "anomaly tests need
  sigma > 0 in the fixture" - seed
  fleet fixtures with varied
  cost/throughput so each verdict
  threshold is exercised distinctly.
- Schema migration: NO new tables.
  Composes existing `pr`,
  `cost_rollup_day`, `run`,
  `project` tables and reuses 0022 /
  0026 / 0035 helpers. Per LESSONS
  § "no backticks inside template-
  literal SQL strings", identifiers
  stay plain.
- No new runtime deps. Pairs with
  0035 (cost-per-PR primitive), 0022
  (fleet temperature signal), 0026
  (streak signal), 0044 (the
  fleet-relative ranking - this is
  the per-project ABSOLUTE
  verdict), 0021 (the autopause is
  the related cost-axis control;
  the verdict is the human-equiv
  decision-support analogue), 0030
  (quiet-hours suppresses the
  sticky-sunset chip).

## Implementation log

- 2026-06-09 — implementation-dev picked up; flipped status to
  in-progress on `feat/0048-per-project-worth-it-verdict`.
  Verified producer casing in `src/ingest/prs.ts` and existing
  helpers' SELECTs: merged PR rows live as `state='MERGED'`
  uppercase + `is_agent=1`, open PRs as `state='open'`
  lowercase, closed non-merged as `state='CLOSED'` uppercase
  (matches LESSONS 2026-06-05 and the 0044/0047 reconciliation).
  Confirmed the `pr` table has no surrogate `id` (PK is
  `(project_id, number)`), so the cache invalidation tuple uses
  `(MAX(fetched_at), COUNT(*))` per LESSONS 2026-06-07. Confirmed
  `src/config.ts` uses a flat `FleetConfig` object with no nested
  keys today; the `worth_it` block is a fresh nested object on
  the config, populated by `Object.assign` from
  `fleet-control.config.json` — no new pattern, just one more
  top-level key whose value is itself an object.
- 2026-06-09 — AC1 arithmetic check: the ticket's `21 PRs × 1h × $75
  / $44 ≈ 3.2x` is actually `35.8x`. Per the ticket's "adjust the
  SEED if the arithmetic doesn't match" instruction the test uses
  `32 PRs × $750` so `32 × 1 × 75 / 750 = 3.2` exactly at the
  default rate. The user-story prose stays unchanged; the test
  arithmetic is load-bearing.
- 2026-06-09 — also fixed in-flight drift on this branch: ticket
  0047 (PR autopsy card) was merged via PR #111 on 2026-06-09 but
  its frontmatter + README index row still said `in-progress`.
  Flipped both to `shipped` here per AGENTS.md's "drift-fix on the
  same branch" rule.
