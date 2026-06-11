---
id: 0056
title: Time saved this month — each project card surfaces ~Nh saved from cross-fleet lessons so the moat becomes visible on the home grid
status: groomed
priority: P1
area: observability
created: 2026-06-11
owner: gtm-innovation
---

## User story

As a fleet operator on the home grid watching 5 project cards, who knows
intellectually that the cross-fleet lessons (0036) are saving heal time
but cannot SEE that value on the cards I look at every day, I want each
project card to grow ONE compact callout `~3.2h saved this month` —
derived deterministically from 0052's lesson-pays-for-itself ledger
divided by a fleet-wide hourly rate per `src/config.ts` — so that the
moat (cross-project wisdom paying rent in every project) becomes
visible in the SAME card the operator already glances at every morning,
not buried two clicks away in `/lessons`.

## Why now (four lenses)

### Product Owner

0052 just shipped the lesson-pays-for-itself ledger as a $-saved
column on the `/lessons` portal page. That's the AGGREGATE view —
"all lessons, sorted by savings." The operator who opens the home
grid (the SINGLE most-trafficked surface in fleet-control) doesn't see
any of this value because the savings live on a separate page. The
smallest meaningful unit of value: ONE compact line on each project
card that converts the per-lesson aggregate savings into a per-project
time-equivalent.

Pure composition over existing data. No new schema. No new ingest
path. No new control surface. The arithmetic: for each project,
sum the `saved_usd` of every cross-fleet lesson whose heal credits
attributed to THIS project in the trailing 30 days, then divide by
`worth_it.hourly_rate_usd` (default 75, matches the 0048 and 0050
precedent) to get hours saved. The callout is `~Nh saved this month`
(rounded to one decimal, prefix `~` to signal estimate). When the
savings are zero, the callout reads `lessons saving you 0h this
month — fleet is still learning`.

PRODUCER-VS-SPEC NOTE: 0052's `lessonSavingsRollup()` (per
`src/views.ts:~4154`) aggregates ACROSS the fleet — the per-
project split is NOT in its output today. This ticket adds a
per-project breakdown via a new helper `lessonSavingsByProject()`
that reads the same `lesson_credit.project_slug` column 0052
already JOINs against. Grep `src/views.ts` for the existing
helper's SELECT shape before extending.

### Stakeholder

Widens the moat on the daily-visibility axis. 0052 made the
lesson-savings VALUE explicit; this ticket makes it VISIBLE in
the surface the operator looks at every morning. Per the cross-
fleet courtiq lesson "an asset that pays rent the operator can't
see is functionally dark code" (CROSS_LESSONS § courtiq Entries
2026-05-21 family on share surfaces — the inverse formulation),
the home-grid callout is the discoverability layer over the
savings ledger. Pairs with 0048 (per-project worth-it verdict —
the home grid already carries verdict badges; this slot is
right beside them), 0052 (the savings data source).

The screenshot worth sharing: a home grid where each card carries
"courtiq · 12 PRs · $25.20 · ~3.2h saved" — the fourth number
is the moat made visible. Structurally impossible for any tool
that doesn't own both the cross-project lessons file and the
heal-attribution ledger.

### User (operator at 9am, glancing at the home grid on a phone)

The existing project card today shows: project name, last shipped
relative time, merged-PR count this month, spend this month, the
0048 worth-it verdict badge (keep / watch / sunset). This ticket
adds ONE compact line below the spend: `~3.2h saved this month`
with `data-testid="project-card-time-saved-<slug>"`. The line is
muted-grey (de-emphasised — it's a moat indicator, not the primary
stat); on tap it navigates to `/lessons?project=<slug>` (filtered
to lessons attributed to this project). At 375px the line is
inline with the spend; at >=600px it's on its own row right-
aligned.

When the project has zero attributed savings this month, the line
reads `lessons saving you 0h this month — fleet is still learning`
(honest empty-state per CROSS_LESSONS § courtiq share-flow
authenticity 2026-05-25 family). Quiet hours softens "saving you"
to "have saved you" (past tense) so the midnight-glance feels
retrospective, not promissory.

The home grid load time MUST NOT regress. The per-project
savings computation is O(projects × lessons) in the worst case;
the helper memoises behind the same daily-rotation cache pattern
as 0055 so the home grid hits a hot cache on 99% of opens.

### Growth

The "show me" moment is the cumulative discoverability arc: a
prospect installs fleet-control via 0046, ships their first PR via
the loop, opens the home grid the next morning, and sees a card
that says "~0.4h saved already." That's the activation hook —
"the fleet is paying for itself from day one because it inherited
the cross-fleet wisdom." Per the cross-fleet courtiq lesson "the
prospect's churn risk is concentrated in the moment they look at
the surface and decide 'this isn't worth my time'" (CROSS_LESSONS
§ courtiq Entries 2026-05-25 family), the time-saved callout is
the per-card answer to that risk every morning.

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: this
spec references 0052's `lessonSavingsRollup()` literally (per
`src/views.ts:~4154`). Per LESSONS 2026-06-05 "groomer prose can
disagree with the schema; the schema wins" the implementing dev
MUST grep `src/views.ts` for the exported helper name and shape
before composing the per-project extension. The `lesson_credit.
project_slug` column is the JOIN key — verify it exists on the
schema (per `src/db.ts:~282`) before writing the SELECT.

- [ ] `src/views.ts` exports `lessonSavingsByProject(db: DB,
      opts?: {windowDays?: number, now?: Date,
      hourlyRateUsd?: number}): LessonSavingsByProject`
      returning `{window_days: number, generated_at: string,
      hourly_rate_usd: number, by_project: Record<string,
      {project_slug: string, project_name: string,
      heal_count: number, saved_usd: number, saved_hours:
      number, lesson_count: number}>}`. The default
      `windowDays` is 30. The default `hourlyRateUsd` is
      `config.worth_it?.hourly_rate_usd ?? 75` (matches the
      0048 / 0050 precedent). The per-project rollup SUMs
      `saved_usd` over `lesson_credit` rows for that
      project in the window, divides by `hourly_rate_usd`
      for `saved_hours`, and counts distinct
      `lesson_credit.lesson_slug` rows for `lesson_count`.
      The per-project `saved_usd` MUST equal each lesson's
      `saved_usd / heal_count * heal_count_for_this_
      project` (the fair-share split of the lesson's savings
      across projects it helped). The `by_project` map is
      keyed by `project_slug` for O(1) lookup from the
      home-grid render. Per LESSONS § "node:sqlite's
      .all() needs `as unknown as T[]`", every row
      narrowing uses the double cast. Per LESSONS § "time-
      pinned tests must NOT derive seed timestamps from
      `new Date()`", every seed anchors to the pinned
      `now`. Test: seed 3 lessons each attributed to 2
      projects with varied heal counts, assert each
      project's `saved_usd` equals the fair-share split;
      assert `saved_hours = saved_usd / 75` rounded to one
      decimal.
- [ ] Empty-fleet behaviour: a fleet with zero
      `lesson_credit` rows returns an empty `by_project`
      map. The home-grid render (AC4) shows the empty-state
      copy "lessons saving you 0h this month — fleet is
      still learning" with `data-testid="project-card-time-
      saved-empty-<slug>"` on EVERY project card. The
      worth-it verdict badge and other card content are
      unaffected. Test: render the home grid against a
      freshly-initialised DB, assert every card carries the
      empty testid and no broken numeric formatting; assert
      the worth-it badge is still present.
- [ ] Idempotency / caching: the helper memoises per tuple
      `(date(now) UTC, MAX(lesson_credit.created_at),
      COUNT(*) FROM lesson_credit, MAX(run.ended_at),
      COUNT(*) FROM run WHERE outcome = <failed-casing>)`.
      Per LESSONS 2026-06-07 "the `pr` table has no
      surrogate `id`; proxy 'latest landed' via (MAX(fetched
      _at), COUNT(*))" — the lesson_credit signal MUST use
      `(MAX(lesson_credit.created_at), COUNT(*))` (no
      surrogate id on this table per the 0052
      implementation log). The `run` pair catches new
      failed runs that re-derive the average-failed-ship
      cost. Per LESSONS § "in-process dedup sets need an
      explicit reset hook for tests", expose
      `_resetLessonSavingsByProjectCacheForTests()` AND
      `_getLessonSavingsByProjectCacheBuildsForTests()`. Per
      LESSONS 2026-06-05 "break ingest↔server cache-
      invalidation cycles via a globalThis slot", the
      invalidation hook MUST register on `globalThis.
      __fleet_lesson_savings_by_project_invalidate__` from
      `src/server.ts` and be read lazily by `runIngestPass`
      AND by the heal-attribution pass in `src/lessons.ts`.
      Test: two calls within TTL assert one build via the
      build counter; insert a fresh lesson_credit row,
      assert the next call rebuilds.
- [ ] `GET /api/fleet/projects` (the existing home-grid
      backing route — PRODUCER-VS-SPEC NOTE: grep
      `src/server.ts` for the actual route path; it may be
      `/api/fleet/home` or `/api/projects` — the existing
      home-grid SPA fetches it) grows ONE OPTIONAL field
      per project row: `time_saved_this_month: {saved_usd:
      number, saved_hours: number, lesson_count: number} |
      null`. The field is OPTIONAL (not required) so any
      older SPA client gracefully ignores it. Per the
      AGENTS.md "Never break the JSON shape of an existing
      `/api/...` route without bumping a version" clause,
      an ADDITIVE field is allowed under the existing shape
      contract — the field is NEW; no existing field
      changes meaning, type, or removal. Per LESSONS §
      "defence-in-depth secret redaction at the renderer
      boundary" AND 2026-06-10 "redactSecrets on a JSON
      body shreds your KEYS" — scrub `project_name`
      VALUES (which originate from operator-supplied repo
      metadata) BEFORE `JSON.stringify`, never the body
      string. Test: hit the home-grid route, assert every
      project row has a `time_saved_this_month` field;
      assert dropping the new field reproduces the byte-
      identical pre-ticket response (regression check);
      assert the helper test from AC1 returns matching
      values per project.
- [ ] `web/app.js` extends the existing home-grid project-
      card render to add ONE line below the spend stat.
      The line uses `formatHoursSaved(saved_hours: number):
      string` helper returning `~Nh saved this month`
      (rounded to one decimal, prefix `~`) or the empty
      copy "lessons saving you 0h this month — fleet is
      still learning" when `saved_hours === 0`. The line
      carries `data-testid="project-card-time-saved-
      <slug>"` and (when non-empty) is wrapped in an
      `<a href="/lessons?project=<slug>">`. Per LESSONS §
      "defence-in-depth secret redaction at the renderer
      boundary", every operator-visible string passes
      through `redactSecrets` BEFORE composition into HTML.
      Test: stub 3 projects with varied saved_hours,
      assert each card's testid renders with the expected
      formatted string; click the line, assert navigation
      to the lessons portal with the project filter
      applied.
- [ ] Mobile (per 0011): at 375px the time-saved line is
      inline with the spend stat (e.g. "$25.20 · ~3.2h
      saved"). At >=600px the line is on its own row
      right-aligned beneath the spend. Test: assert the
      existing mobile-portal text-level CSS contract at
      375px (inline) and 600px (own row) viewport widths.
- [ ] Quiet-hours integration (per 0030): when
      `quietHoursActive` is `true`, the line copy softens
      from "~3.2h saved this month" to "~3.2h saved over
      the last 30 days" (removes the present-tense "this
      month" framing). The link target is unchanged. The
      empty-state copy softens from "lessons saving you 0h
      this month — fleet is still learning" to "lessons
      have saved you 0h over the last 30 days — fleet is
      still learning." Matches the 0048 / 0050 / 0053
      precedent: information visible, tense softened.
      Test: stub quiet hours active, assert the line copy
      contains "last 30 days" (no "this month"); stub
      inactive, assert "this month" appears.
- [ ] Performance: the home-grid render with
      `time_saved_this_month` populated for 10 projects
      completes within 5ms of the pre-ticket baseline
      render (cache hit). Cache miss adds at most 50ms for
      the lessonSavingsByProject helper across 10 projects
      and 200 lesson_credit rows. Per LESSONS § "in-process
      startServer() tests need an empty-roots config + run-
      row seeds", server-boot tests plant a tmp `fleet-
      control.config.json` in cwd and restore on cleanup.
      Per LESSONS § "julianday() drifts ~10us per
      timestamp", any 30-day window timestamp diff uses
      `strftime` decomposition. Test: seed the dataset,
      time both paths, assert thresholds (skip when
      `process.env.PERF !== "1"`).
- [ ] PWA / offline (per 0029): the home-grid response is
      already cached by the service worker. The new
      `time_saved_this_month` field rides on the existing
      cache entry — no service-worker change needed. When
      offline, the cards render the last-cached saved-
      hours value. Test: stub the fetch to fail, assert the
      cards render with their last-cached time-saved
      values; stub the fetch to succeed with a fresh
      number, assert the cards re-render with the fresh
      value.
- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-
      string composition. The additive field on the home-
      grid route does NOT count as a JSON-shape break per
      the AGENTS.md contract (existing fields unchanged;
      only NEW optional field added). No schema migration —
      composes existing `lesson_credit`, `run`, `project`
      tables. Per LESSONS § "no backticks inside template-
      literal SQL strings", identifiers stay plain words.

## Out of scope

- A "lifetime hours saved" column. The 30-day window is the
  load-bearing comparator; lifetime savings invite
  endless-growth visual artifacts that overshadow the
  current-month signal.
- A breakdown chart of "which lessons saved you which hours
  on this project." That's the per-project graveyard +
  /lessons combo — the home-card line is a single
  number by design.
- A "you would have saved Nh more if you'd used lesson X"
  counterfactual. Counterfactuals invite endless debate;
  the actual ledger is the load-bearing number.
- A "hours saved across all your projects" fleet summary
  card on the home grid. The aggregate is in 0052's
  lessons portal and 0050's year-in-review; the home-grid
  surface is per-project by design.
- An LLM-authored "this project benefited most from
  lessons X, Y, Z." Deterministic ranking is the load-
  bearing signal.
- A configurable hourly rate per project. Single rate
  (per `config.worth_it.hourly_rate_usd`, default 75)
  matches the 0048 / 0050 precedent and avoids per-
  project knob proliferation.
- An ntfy push when a project crosses a savings threshold
  ("~10h saved this month — celebrate!"). Pull-only
  surface; the home-card glance is the signal.
- A multi-fleet (cross-operator) "your fleet saved more
  than 80% of similar-sized fleets" comparison. Single-
  fleet by design.

## Engineering notes

- `src/views.ts` — new `lessonSavingsByProject(db, opts)`
  helper near the existing `lessonSavingsRollup()` (line
  ~4154). PRODUCER-VS-SPEC NOTE: grep `src/views.ts` for
  the existing rollup's SELECT shape and JOIN keys; the
  new helper SHARES the cost-per-failed-ship arithmetic
  and the lesson_credit JOIN, splitting only on the
  per-project GROUP BY. Per LESSONS § "node:sqlite's
  .all() needs `as unknown as T[]`", every row narrowing
  uses the double cast. Per LESSONS § "PRODUCER-VS-SPEC
  for column-value casing" (2026-06-05), grep the
  ingester for `run.outcome` literal AND
  `control_audit.action` literal before composing the
  JOIN predicates — the 0052 implementation log already
  reconciled these (`outcome='failure'` lowercase,
  `action='heal'` lowercase) but re-confirm.
- `src/server.ts` — amend the existing home-grid handler
  to JOIN the per-project savings into the response.
  PRODUCER-VS-SPEC NOTE: grep `src/server.ts` for the
  exact handler — likely `GET /api/fleet/home` or
  `/api/fleet/projects`. Per LESSONS 2026-06-05 "break
  ingest↔server cache-invalidation cycles via a
  globalThis slot", the cache invalidation function MUST
  be registered on `globalThis.
  __fleet_lesson_savings_by_project_invalidate__` from
  `src/server.ts` and read lazily by `runIngestPass` AND
  by `attributeHealsToLessons()` in `src/lessons.ts`
  (matches the 0052 invalidation chain).
- `web/app.js` — extend the existing home-grid project-
  card render. PRODUCER-VS-SPEC NOTE: grep `web/app.js`
  for the existing project-card render function and the
  `usd()` / `formatHoursAgo()` helper conventions before
  writing the new line. The lessons-portal navigation
  with the `?project=<slug>` query string requires the
  0036 lessons portal to honour that filter — verify it
  does, or add it as a sibling AC (it most likely
  already does per the 0036 spec). The `localStorage`
  dismiss pattern from 0055 is NOT used here — the
  time-saved line is not dismissible (it's a stat, not
  a tip).
- `web/style.css` — one selector group for the time-
  saved line (muted-grey, smaller font than the primary
  stats, reuses existing CSS variables). Reuse existing
  CSS variables for color and font; do NOT add new ones.
- `tests/lesson-savings-by-project.test.ts` (new) — one
  `test(...)` per AC checkbox. Per LESSONS § "time-
  pinned tests must NOT derive seed timestamps from
  `new Date()`", every seed anchors to the test's pinned
  `now`. Per LESSONS § "in-process startServer() tests
  need an empty-roots config + run-row seeds", server-
  boot tests plant a tmp `fleet-control.config.json` in
  cwd and restore on cleanup. Per LESSONS § "anomaly
  tests need σ > 0 in the fixture", AC1's fixture
  spreads per-project savings geometrically so the
  fair-share split is observable. Per LESSONS § "expose
  a build counter for cache-hit tests, not a fetcher
  swap", AC3 uses the build counter. Per LESSONS § "when
  an ingester grows a second shell-out, legacy stubs
  that don't discriminate on argv silently collide" —
  the home-grid handler test should NOT regress 0042 /
  0048 / 0052 tests that already cover the existing
  response shape; run those alongside the new tests.
- Schema migration: NO new tables. Composes existing
  `lesson_credit`, `run`, `control_audit`, `project`
  tables.
- No new runtime deps. Pairs with 0052 (lesson-pays-for-
  itself ledger — the source data), 0048 (worth-it
  verdict — shares the home-card slot), 0036 (lessons
  portal — the navigation target), 0033 (yesterday
  glance — shares the home-page region), 0029 (PWA —
  the response rides the existing cache entry), 0030
  (quiet hours — softens the tense).

## Implementation log

(Appended by the implementation-dev agent during execution.)
