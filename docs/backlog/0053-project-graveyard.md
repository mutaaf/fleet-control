---
id: 0053
title: Project graveyard — paused / sunset projects get a memorial page tallying lifetime ROI and what they taught the fleet
status: in-progress
priority: P1
area: portal
created: 2026-06-10
owner: gtm-innovation
---

## Implementation log

- 2026-06-11 implementation-dev: branched feat/0053-project-graveyard.
  Producer reconciliation per LESSONS 2026-06-05:
  * `project_pause.reason` actually written by `src/budget_guard.ts:187`
    is the literal `'cost_cap'` (lowercase, snake-case). The schema
    docstring (`src/db.ts:185`) reserves `'manual'` for future use but
    v1 never writes it. Spec named `'budget'`/`'budget_cap'`/`'sunset'`/
    `'sunset_candidate'` — none of these literals exist on disk today.
    Classification map: `'cost_cap'`/`'budget'`/`'budget_cap'` →
    `"budget_autopause"`; `'sunset'`/`'sunset_candidate'` →
    `"sunset_verdict"`; anything else (incl. null) → `"manual"`. The
    `'budget'`/`'sunset'` arms are forward-compat for a future writer.
  * `project_pause` schema (`src/db.ts:189-195`): PK is `project_id`
    (not `(project_slug, ...)` as the spec hedged). No `active` column
    — a row's mere presence means paused (matches the 0054 pulse
    reconciliation at `src/views.ts:6576`). Cache invalidation tuple
    uses `(MAX(triggered_at), COUNT(*))` since there's no `paused_at`
    column either; `triggered_at` is the producer's spelling.
  * `pr.state = 'MERGED'` uppercase (matches `src/ingest/prs.ts:152`).

## User story

As a fleet operator who has paused two projects over the past three
months because they weren't paying off (one via the 0048 sunset
verdict, one via the 0021 budget autopause), and who feels the
private friction of "did I just throw money away on those" every
time I see them missing from the home grid, I want a single
`/graveyard` page that lists every paused or sunset project with
its lifetime merged PRs, lifetime spend, lifetime ROI, the date it
was paused, the verdict it died on, and any cross-fleet lessons
its failures contributed to, so that paused projects become a
visible ledger of what I learned rather than a private guilt list
that pushes me to over-commit to whatever is currently green.

## Why now (four lenses)

### Product Owner

0021 (budget autopause), 0048 (sunset verdict), and the existing
`project_pause` table give fleet-control a complete record of every
sunset event — but no surface SHOWS it. The home grid hides paused
projects (correctly — they don't need daily attention); the
project page is alive only for non-paused projects. The result:
paused projects are invisible until the operator goes looking,
which means the SHAPE of the operator's loss history is invisible
too. The smallest meaningful unit of value: ONE new page (single
GET, single JSON route) that converts the loss column into a
visible ledger. No new schema, no new ingest path, no new control
surface — composes the existing `project_pause`, `pr`,
`cost_rollup_day`, and `lesson_credit` tables. Subtraction beats
addition: this page REMOVES the operator's "am I just paying for
the wins to make up for the losses I'm hiding" worry, which is the
exact friction that 0048's sunset verdict creates without a place
to LOOK AT what's been sunset.

### Stakeholder

Widens the moat on the loss-accounting axis where no competitor
has structural data. GitHub-native shows you each archived repo
in isolation; Anthropic console has no per-repo cost history past
its rolling window; spreadsheets don't track pauses. Only fleet-
control has the full pause-event record + the cost rollups + the
lesson-credit attribution all reconciled. Per the cross-fleet
courtiq lesson "loss-accounting is the most-asked-for surface that
no commercial dashboard ships, because it's a moat against the
operator's defection to a simpler tool" (CROSS_LESSONS § courtiq
Entries 2026-05-20 family — the "tend the lowest-numbered PR"
posture is the same shape: visibility on the unglamorous things
prevents drift), the graveyard is the structural answer to "what
did I sunset and was I right to."

### User (operator on a Sunday evening, reviewing what to add back)

The page is one long single-column list. Header: a summary line
"5 projects paused · 47 lifetime merged PRs · $620 lifetime spend ·
3 lessons authored." Below: one row per paused project, sorted by
pause date desc (most recent first). Each row carries the project
slug, the pause date, the pause reason (verdict from 0048 OR
budget autopause from 0021 OR manual), lifetime merged PRs,
lifetime spend, lifetime ROI (computed at the moment of pause —
not as-of-today), and the count of cross-fleet lessons attributed
to this project (a small chip linking to the lessons portal
filtered by the project). The row has ONE action button "consider
reviving" that navigates to the existing project register surface
with the slug pre-filled. The page is mobile-first (375px,
one column, no horizontal scroll). When zero projects are paused,
the page renders one sentence: "the fleet is fully active — no
sunset history to remember yet." Loss-framing language is
suppressed under quiet hours (per 0030 precedent).

### Growth

The "show me" moment is structurally counter-intuitive: most
acquisition dashboards hide losses. The graveyard shows them
front-and-center BUT recasts them as a ledger of learning. Per
the cross-fleet courtiq lesson "the operator's churn risk is
concentrated in the moment they look at the surface and decide
'this tool only shows me wins,' which makes them mistrust the
wins too" (CROSS_LESSONS § courtiq Entries 2026-05-25 family —
the share-flow conversion footer's authenticity), the graveyard
inverts that risk by being deliberately honest. The screenshot
worth sharing: a graveyard with "5 paused · $620 lifetime spend ·
3 lessons authored" — the second number normalises the loss, the
third re-frames it as productive. Pairs with 0048 (the per-
project verdict) and 0050 (year-in-review): 0048 is the moment of
decision, the graveyard is the long memory of that decision, 0050
is the annual roll-up. Together they form the complete
retrospective surface fleet-control is uniquely positioned to
ship.

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: this
spec names `project_pause.reason` literally (e.g. `'budget'`,
`'sunset'`, `'manual'`) — per LESSONS 2026-06-05 "groomer prose
can disagree with the schema; the schema wins" the implementing
dev MUST grep `src/control.ts` (or wherever pause rows are
written) for the producer's actual `reason` values. The producer's
casing is the contract. Same for `pr.state = 'MERGED'` (uppercase
per the 0040 / 0044 / 0047 / 0048 reconciliation) and `pr.state =
'open'` (lowercase) — grep `src/ingest/prs.ts` before composing
the lifetime SELECT.

- [ ] `src/views.ts` exports `projectGraveyard(db: DB, opts?:
      {now?: Date, hourlyRateUsd?: number, hoursPerPr?:
      number}): ProjectGraveyard` returning `{generated_at:
      string, summary: {paused_count: number,
      lifetime_merged_prs: number, lifetime_spend_usd: number,
      lessons_authored: number}, projects: Array<{project_slug:
      string, project_name: string, paused_at: string,
      pause_reason: string, lifetime_merged_prs: number,
      lifetime_spend_usd: number, lifetime_cost_per_pr_usd:
      number | null, lifetime_roi_multiplier: number | null,
      lessons_authored: number, first_run_at: string | null,
      last_run_at: string | null}>}`. The `projects` array is
      sorted by `paused_at` descending. `lifetime_merged_prs`
      counts every `pr` row for the project where the state
      matches the producer's "MERGED" casing AND `fetched_at <=
      paused_at`. `lifetime_spend_usd` sums `cost_rollup_day.
      cost_usd` for the project where `day <= paused_at`.
      `lifetime_roi_multiplier` is `(lifetime_merged_prs *
      hoursPerPr * hourlyRateUsd) / lifetime_spend_usd` (null
      when spend is zero). `lessons_authored` counts distinct
      `lesson_credit.lesson_slug` rows where the
      `project_slug` matches AND `created_at <= paused_at` (a
      lesson the project's failures attributed to). Defaults
      from `src/config.ts` per the 0048 precedent: `hourlyRate
      Usd = worth_it.hourly_rate_usd ?? 75`, `hoursPerPr =
      worth_it.hours_per_pr ?? 1`. Per LESSONS § "node:
      sqlite's .all() needs `as unknown as T[]`", every row
      narrowing uses the double cast. Per LESSONS § "time-
      pinned tests must NOT derive seed timestamps from `new
      Date()`", every seed anchors to the pinned `now`. Test:
      seed 3 paused projects with varied lifetimes, assert
      `summary.paused_count === 3` and `projects[0]` is the
      most-recently-paused row.
- [ ] Pause-reason classification: each `project_pause` row's
      `reason` is mapped to one of three displayed labels:
      `"sunset_verdict"` (when the producer wrote
      `'sunset'` or `'sunset_candidate'`), `"budget_
      autopause"` (when the producer wrote `'budget'` or
      `'budget_cap'`), or `"manual"` (anything else,
      including null). The helper exposes the RAW producer
      reason on the row as `pause_reason_raw` AND the
      classified label as `pause_reason`. PRODUCER-VS-SPEC
      NOTE: grep `src/control.ts` for the literal `reason`
      values BEFORE writing the mapping — the producer's
      vocabulary is the contract. Test: seed pause rows
      with each producer reason, assert the classification
      maps correctly; seed a pause with an unknown reason,
      assert the label is `"manual"`.
- [ ] Idempotency / caching: the helper memoises per tuple
      `(MAX(project_pause.paused_at), COUNT(*) FROM
      project_pause WHERE active = <truthy>, MAX(pr.fetched_
      at), COUNT(*) FROM pr WHERE state = <merged-casing>)`.
      Per LESSONS 2026-06-07 "the `pr` table has no
      surrogate `id`; proxy 'latest landed' via (MAX(fetched_
      at), COUNT(*))" — the PR signal MUST use `(MAX(pr.
      fetched_at), COUNT(*))`, NEVER `MAX(pr.id)`. Same for
      `project_pause` (PK is `(project_slug, ...)` per the
      0021 schema — grep `src/db.ts` to confirm); use
      `MAX(paused_at) + COUNT(*)`. Per LESSONS § "in-process
      dedup sets need an explicit reset hook for tests",
      expose `_resetGraveyardCacheForTests()` AND
      `_getGraveyardCacheBuildsForTests()` per LESSONS §
      "expose a build counter for cache-hit tests, not a
      fetcher swap". Test: two calls assert one build;
      insert a new pause row, assert the next call rebuilds.
- [ ] `GET /api/fleet/graveyard` returns the AC1 shape as
      JSON. Requires `read` scope. The response sets `Cache-
      Control: max-age=1800` (30 min — paused-project state
      moves slowly). Per LESSONS § "defence-in-depth secret
      redaction at the renderer boundary", the response
      passes through `redactSecrets`. Test: hit without auth
      → 401; hit with `read` against a seeded fleet → 200
      with the shape; hit with `read` against an empty fleet
      → 200 with `summary.paused_count === 0` and an empty
      `projects` array.
- [ ] `web/app.js` adds a hash route `#/graveyard` that
      renders the page. Container `data-testid="graveyard"`.
      Summary header `data-testid="graveyard-summary"` with
      the four summary numbers as separate
      `data-testid="graveyard-summary-paused-count"`,
      `data-testid="graveyard-summary-merged-prs"`,
      `data-testid="graveyard-summary-spend"`,
      `data-testid="graveyard-summary-lessons"` spans. Each
      project row carries `data-testid="graveyard-row-
      <slug>"` with child cells `data-testid="graveyard-row-
      <slug>-paused-at"`, `-reason`, `-merged-prs`,
      `-spend`, `-roi`. The revive button per row carries
      `data-testid="graveyard-row-<slug>-revive"`. Per
      LESSONS § "defence-in-depth secret redaction at the
      renderer boundary", every operator-visible string
      passes through `redactSecrets`. Test: render with 2
      seeded paused projects, assert the summary testids and
      both per-row testids are present and carry the
      expected values.
- [ ] Empty-state: when `summary.paused_count === 0` the
      page renders ONE sentence with `data-testid=
      "graveyard-empty"`: "the fleet is fully active — no
      sunset history to remember yet." No row containers,
      no broken testids. Test: render against a freshly-
      initialised DB, assert the empty testid is present
      and no `graveyard-row-` testid appears.
- [ ] Mobile (per 0011): at 375px viewport each row stacks
      vertically (project slug + paused date on row 1,
      lifetime numbers on row 2, revive button on row 3),
      no horizontal scroll. At >=900px the row is a single
      table-like line. Test: assert the existing mobile-
      portal text-level CSS contract at 375px (stacked) and
      900px (inline) viewport widths.
- [ ] Quiet-hours integration (per 0030): when
      `quietHoursActive` is `true`, the "consider reviving"
      button per row is hidden (a midnight portal-open
      should not nudge the operator into an impulsive
      revive). The page itself, the summary numbers, and
      the row data all remain visible. Loss-framing in the
      summary headline is also softened: instead of "5
      projects paused" the headline reads "5 projects
      resting." Matches the 0048 / 0050 precedent:
      information visible, prompts and loss framing
      suppressed. Test: stub quiet hours active, assert no
      `graveyard-row-*-revive` testid is rendered AND the
      summary headline contains "resting"; stub inactive,
      assert the revive button is present AND the headline
      contains "paused."
- [ ] Cross-link from the project page (the existing
      `/p/<slug>` surface): when a project IS paused, the
      project page grows a single line near the top with
      `data-testid="project-paused-banner"` linking to
      `#/graveyard` and naming the pause reason ("Paused
      via budget autopause on <date> — see graveyard for
      the full record"). The banner is informational, not a
      modal — it does not block any existing project-page
      content. PRODUCER-VS-SPEC NOTE: grep `web/app.js` for
      the existing project-page render path before placing
      the banner. Test: render the project page for a
      paused project, assert the banner testid is present
      and its href is `#/graveyard`; render for an active
      project, assert no banner.
- [ ] Performance: `projectGraveyard(db, opts)` against a
      seeded fleet of 10 paused projects and 1,000 PRs
      completes in under 100ms (cache miss) and under 5ms
      (cache hit). Per LESSONS § "in-process startServer()
      tests need an empty-roots config + run-row seeds",
      server-boot tests plant a tmp `fleet-control.config.
      json` in cwd and restore on cleanup. Per LESSONS §
      "julianday() drifts ~10us per timestamp", any
      lifetime-window timestamp diff uses `strftime`
      decomposition. Test: seed the dataset, time both
      paths, assert thresholds (skip when `process.env.
      PERF !== "1"`).
- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-
      string composition. No JSON-shape break to any
      existing `/api/...` route (the route is net-new; the
      project page's banner reads the existing pause state,
      no new field on the project page response). No
      schema migration — composes existing `project`,
      `project_pause`, `pr`, `cost_rollup_day`, `lesson_
      credit` tables. Per LESSONS § "no backticks inside
      template-literal SQL strings", identifiers stay
      plain words.

## Out of scope

- An UNPAUSE action from the graveyard page itself (the
  revive button NAVIGATES to the existing register surface
  rather than performing the unpause inline). Inline
  control widens the surface beyond pull-only; unpause
  lives on the project page where it always has.
- A "regret score" verdict ("you should have kept this
  project — it would have shipped 15 more PRs"). Counter-
  factual projections invite endless debate without cure.
- A per-project graveyard view (each project's full
  history of every pause/unpause). The aggregate page is
  the v1 unit; per-project history is a follow-up.
- An LLM-authored "why this project was sunset" prose
  paragraph per row. The classification is deterministic
  and short.
- A "memorial" public share link of the graveyard page.
  Single-fleet, token-gated; sharing the loss column is a
  separate decision the operator can make manually.
- An ntfy push when a project tips into the graveyard.
  The 0048 sunset verdict and the 0021 budget autopause
  already push at the moment of decision; the graveyard
  is the long memory, not the alert.
- Auto-deletion of projects from the graveyard after N
  months. The ledger is permanent — the cure for "too
  many graves" is to revive or to manually deregister,
  not to forget.
- Cross-fleet (multi-operator) graveyard. Single-fleet by
  design.

## Engineering notes

- `src/views.ts` — new `projectGraveyard(db, opts)` helper
  next to the existing `projectWorthItVerdict` (line
  ~5323). The lifetime computation REUSES the same
  arithmetic shape as 0048's verdict but over the project's
  ENTIRE history (no window). PRODUCER-VS-SPEC NOTE: grep
  `src/control.ts` for the literal `project_pause.reason`
  values written by the autopause action AND the manual
  pause action — the producer's vocabulary is the contract
  per LESSONS 2026-06-05. Same for `pr.state` — grep
  `src/ingest/prs.ts` for the literal casing before
  composing the lifetime SELECT. Per LESSONS § "node:
  sqlite's .all() needs `as unknown as T[]`", every row
  narrowing uses the double cast.
- `src/server.ts` — one new handler `GET /api/fleet/
  graveyard` (JSON, behind `read` scope). Per LESSONS
  2026-06-05 "break ingest↔server cache-invalidation
  cycles via a globalThis slot", the graveyard cache
  invalidation function MUST be registered on
  `globalThis.__fleet_graveyard_invalidate__` from
  `src/server.ts` and read lazily by `runIngestPass`. The
  pause-event flip (when an operator pauses or unpauses)
  ALSO needs to invalidate — grep `src/control.ts` for the
  pause/unpause write path and call the invalidation
  function from there too.
- `web/app.js` — add a hash route `#/graveyard` with its
  own render function. Add a project-page banner render
  guarded by `if (project.paused_at)`. PRODUCER-VS-SPEC
  NOTE: grep `web/app.js` for the existing project-page
  render path and the existing `formatUsd` / pause-aware
  helpers before writing — the helpers likely already
  exist for the home-grid filter (paused projects are
  already hidden somewhere; reuse the predicate).
- `web/style.css` — one selector group for the graveyard
  row, one for the summary header, one for the project-
  page banner. Reuse existing CSS variables for color and
  font; do NOT add new ones.
- `tests/graveyard.test.ts` (new) — one `test(...)` per
  AC checkbox. Per LESSONS § "time-pinned tests must NOT
  derive seed timestamps from `new Date()`", every seed
  anchors to the test's pinned `now`. Per LESSONS § "in-
  process startServer() tests need an empty-roots config
  + run-row seeds", server-boot tests plant a tmp `fleet-
  control.config.json` in cwd and restore on cleanup. Per
  LESSONS § "anomaly tests need σ > 0 in the fixture",
  seed varied lifetime spend / PR counts so the summary
  arithmetic and per-row ROI are geometrically meaningful.
  Per LESSONS § "expose a build counter for cache-hit
  tests, not a fetcher swap", AC3 uses the build counter.
- Schema migration: NO new tables. Composes existing
  `project`, `project_pause`, `pr`, `cost_rollup_day`,
  `lesson_credit` tables.
- No new runtime deps. Pairs with 0021 (budget autopause
  is one of the pause sources), 0048 (sunset verdict is
  the other primary pause source — the graveyard is its
  long memory), 0042 (lesson credit ledger provides the
  `lessons_authored` count per project), 0050 (year-in-
  review — the graveyard is the project-level memory;
  0050 is the year-level retrospective), 0030 (quiet
  hours suppresses revive prompts and loss framing).
