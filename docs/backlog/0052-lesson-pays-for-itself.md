---
id: 0052
title: Lesson-pays-for-itself ledger — each cross-fleet lesson grows a $$ saved tally from the heal-credit attributions
status: in-progress
priority: P1
area: observability
created: 2026-06-10
owner: gtm-innovation
---

## Implementation log

- 2026-06-10 — Picked up by implementation-dev on
  `feat/0052-lesson-pays-for-itself`. PRODUCER-VS-SPEC reconciliation:
  - `run.outcome` failed-run literal: the producer in
    `src/ingest/transcripts.ts:outcomeOf()` does NOT emit a "failed"
    label directly (the seven branches are smoke, usage-limit, shipped,
    healed, no-op, reviewed-changes, reviewed-ok, self-cancel). The
    de-facto schema-language across the rest of the codebase
    (`views.ts`, tests for `inbox`, `streak`, `badge`, `health`,
    `monday-catchup`, `friday-wrap`, `glance`) treats `outcome =
    'failure'` (lowercase) as the failed-run literal — that's the
    fleet-control convention. Implementation matches: SELECT
    `outcome = 'failure'`.
  - `control_audit.action` heal literal: producer is the `audit()`
    helper in `src/control.ts`. Existing helpers (`src/lessons.ts:627`,
    `src/views.ts:3128, 4650, 4787, 4958`, `src/server.ts:265,504`)
    all use `action = 'heal'` lowercase. Matches.
  - Existing route `/api/fleet/lessons` (not `/api/lessons` as the
    spec prose says). New route lands as `/api/fleet/lessons/savings`.
    The additive `savings` field is appended onto the existing
    `/api/fleet/lessons` shape per AC4.
  - `lesson_credit` PK is composite `(lesson_slug, lesson_date,
    heal_audit_id)` — no surrogate id. Cache invalidation tuple uses
    `(MAX(created_at), COUNT(*))` on lesson_credit + `(MAX(ended_at),
    COUNT(*))` on run filtered to `outcome = 'failure'`.
  - GlobalThis slot for cache invalidation:
    `__fleet_lesson_savings_invalidate__`. Registered from
    `src/server.ts` on module load; read lazily from `runIngestPass`
    (after COMMIT) and from `attributeHealsToLessons()` in
    `src/lessons.ts` (after a non-zero insert count).
  - USD formatter in SPA: `usd(n)` (not `fmtUsd` / `formatDollars`).

## User story

As a fleet operator reading the cross-fleet lessons portal (0036)
who has watched the lesson-credit ledger (0042) accumulate ~200
heal attributions over the past quarter and is wondering "which of
these lessons is actually paying for itself in dollars saved versus
the daemon ticks they cost," I want each lesson row to grow ONE
extra column "$ saved" — computed deterministically as
`heal_count * average_failed_heal_cost_usd` from the trailing 90
days of `control_audit` — so that the lessons portal stops being a
flat list and becomes a ranked ledger of "this lesson saved me
$420 across the fleet last quarter" reverse-attributed to the
specific PR healed.

## Why now (four lenses)

### Product Owner

0042 (lesson credit ledger) attributes heals to lessons. 0036
(cross-fleet lessons portal view) renders the lesson list. Neither
answers the operator's actual question: "of all these lessons, which
ones are actually paying for themselves in dollars saved by avoiding
a re-shipped failure?" The smallest meaningful unit of value: ONE
new column on the existing lessons portal, plus ONE new JSON field
on the existing `/api/lessons` route, derived deterministically from
already-ingested `control_audit` heal rows joined to the
`lesson_credit` ledger. No new schema. No new ingest path. No new
control surface. The math is straightforward: a heal attribution
saved the cost of the FOLLOW-UP failed ship that the lesson averted.
Average that cost over the trailing 90 days of `run` rows whose
`outcome` is `failed` (PRODUCER-VS-SPEC NOTE: see AC1), multiply by
the heal count, attribute to the lesson.

### Stakeholder

Widens the moat on the structural-impossibility-for-competitors
axis. Per the cross-fleet courtiq lesson "the share-worthy moment
is the verdict that closes a question the operator was carrying"
(CROSS_LESSONS § courtiq Entries 2026-05-20 family, restated by
0048's stakeholder argument), this is the lesson-ledger version of
the same shape: the $ saved per lesson is a number ONLY fleet-
control's SQLite can compute, because it requires (a) the cross-
fleet lessons file as a structured input (0036), (b) the heal-
attribution data (0042), and (c) the cost data of failed runs (0035
/ 0044), all reconciled in one query. GitHub-native has no cost
data. Anthropic console has no PR-heal attribution. A spreadsheet
has neither. The screenshot worth sharing: the lessons portal
sorted by "$ saved" descending — "the 2026-05-26 'async streaming
tails: snapshot the path before each read' lesson saved this fleet
$420 across 14 heals last quarter." That's a verdict no one else
can author.

### User (operator at 9am, glancing at the lessons portal)

The 0036 lessons portal renders each cross-fleet lesson as a row.
Today the row carries `date | project | one-line headline | tags`.
This ticket adds ONE column: `saved_usd` (right-aligned, monospace,
formatted as `$420.00` with two decimals, or `--` when the lesson
has zero heal credits in the window). The row is sortable by the
new column (the existing sort surface in 0036 likely supports
one sort key; add `saved_usd_desc` to the allowlist). On phone the
column collapses behind the existing 0036 row-expand chevron; the
$ figure remains visible inline with the headline ("$420 · async
streaming tails: snapshot the path…"). At a glance the operator
sees which lessons are actually paying rent. The page works
offline (per 0029) against the cached snapshot. The number is
hover-tooltipped with the arithmetic: "14 heals × $30/avg failed
ship = $420 saved (trailing 90 days)."

### Growth

The screenshot worth sharing inverts the usual fleet-control pitch
("we observe your agents") into "we observe the LESSONS your agents
learn, and credit them in dollars." Per the cross-fleet courtiq
lesson "any artifact that survives the moment and gets shared is
worth more than ten dashboards" (CROSS_LESSONS § courtiq Entries
2026-05-21 family on share surfaces), the dollarised lesson ledger
is exactly that artifact. The natural pitch line:
"fleet-control's cross-fleet lessons saved $X across N projects
last quarter, automatically attributed by SQL." Compelling to
adopters running 3+ projects (the only fleet size where cross-
project savings even register).

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: this
spec names `run.outcome = 'failed'` literally — per LESSONS
2026-06-05 "groomer prose can disagree with the schema; the schema
wins" the implementing dev MUST grep `src/ingest/runs.ts` (or
wherever the `run.outcome` column is written) for the producer's
actual casing AND value set before writing the SELECT. The
producer's literal values are the contract — `'failed'`,
`'failure'`, `'fail'`, and `'red'` are all plausible casings; the
ingester decides. Same for `control_audit.action` (this spec names
`'heal'` literally but the producer may write `'heal_attempt'`,
`'heal_recovery'`, or a phased label — grep the writer before
writing the JOIN predicate).

- [ ] `src/views.ts` exports `lessonSavingsRollup(db: DB, opts?:
      {windowDays?: number, now?: Date}):
      LessonSavingsRollup` returning `{window_days: number,
      generated_at: string, average_failed_ship_cost_usd:
      number, lesson_savings: Array<{lesson_slug: string,
      lesson_date: string, lesson_title: string, heal_count:
      number, saved_usd: number, first_credited_at: string,
      last_credited_at: string, projects_helped: number}>}`.
      The default `windowDays` is 90. The
      `average_failed_ship_cost_usd` is the mean of
      `run.cost_usd` over `run` rows where `outcome` matches the
      producer's "failed" value AND `started_at` falls in the
      window. When the window has zero failed runs, the average
      defaults to a sane floor (`5.0` — documented in JSDoc)
      so the rollup is well-defined on a freshly-onboarded
      fleet. `saved_usd = heal_count *
      average_failed_ship_cost_usd`, rounded to two decimals.
      Per LESSONS § "node:sqlite's .all() needs `as unknown as
      T[]`", every row narrowing uses the double cast. Per
      LESSONS § "time-pinned tests must NOT derive seed
      timestamps from `new Date()`", every seed anchors to the
      pinned `now`. Test: seed 14 heal_credit rows attributed
      to one lesson, seed 20 failed runs at $30 each, assert
      that lesson's `saved_usd === 420.00` and the average
      cost is $30. Seed a fresh fleet with zero failed runs,
      assert the floor of $5.00 applies.
- [ ] Idempotency: a second call within the cache TTL returns
      the same `generated_at` and the same `saved_usd` array.
      The cache invalidates when (a) a new `lesson_credit` row
      lands or (b) a new `run` row with `outcome` matching the
      failed value lands. Per LESSONS 2026-06-07 "the `pr`
      table has no surrogate `id`; proxy 'latest landed' via
      (MAX(fetched_at), COUNT(*))": the lesson_credit table
      DOES have an implicit-rowid `created_at` and a composite
      PK; use the tuple `(MAX(lesson_credit.created_at),
      COUNT(*) FROM lesson_credit, MAX(run.ended_at), COUNT(*)
      FROM run WHERE outcome = <failed-casing>)` as the cache
      key. NEVER assume a surrogate `id` exists on
      `lesson_credit` (the schema defines its PK as
      `(lesson_slug, lesson_date, heal_audit_id)` — no
      `id INTEGER PRIMARY KEY`). Test: two calls within TTL
      assert one build via
      `_getLessonSavingsCacheBuildsForTests()`; insert a fresh
      `lesson_credit` row, assert the next call rebuilds.
- [ ] `GET /api/lessons/savings` returns the AC1 shape as JSON.
      Requires `read` scope. The response sets `Cache-Control:
      max-age=900` (15 min — matches 0044, 0048). Per LESSONS
      § "defence-in-depth secret redaction at the renderer
      boundary", the response passes through `redactSecrets`
      before `res.end`. Test: hit without auth → 401; hit with
      `read` against a seeded fleet → 200 with the shape; hit
      with `read` against an empty fleet → 200 with empty
      `lesson_savings` array and the floor average.
- [ ] `/api/lessons` (the existing 0036 lessons route) grows
      ONE optional response field `savings: {lesson_slug:
      string, saved_usd: number} | null` on EACH lesson row.
      The field is OPTIONAL on the response shape (not
      required) so any older SPA client gracefully ignores it.
      Per the AGENTS.md "Never break the JSON shape of an
      existing `/api/...` route without bumping a version"
      clause, an ADDITIVE field is allowed under the existing
      shape contract — the field is NEW; no existing field
      changes meaning, type, or removal. The savings field is
      populated by joining the existing 0036 lessons payload
      against the AC1 helper output. Test: hit `/api/lessons`,
      assert every row has a `savings` field; assert dropping
      the savings field reproduces the byte-identical pre-
      ticket response (regression check).
- [ ] `web/app.js` extends the existing 0036 lessons portal
      view to render a new column `saved_usd` per row. Column
      header `data-testid="lessons-saved-usd-header"` is
      clickable to sort the list `saved_usd_desc`. Each row
      grows `data-testid="lessons-saved-usd-<lesson_slug>"`
      with the formatted dollar value. The hover tooltip
      `data-testid="lessons-saved-usd-tooltip-<lesson_slug>"`
      shows the arithmetic: "<heal_count> heals × $<avg>/avg
      failed ship = $<saved> saved (trailing <N> days)". Per
      LESSONS § "defence-in-depth secret redaction at the
      renderer boundary", every operator-visible string passes
      through `redactSecrets`. Test: stub three lessons with
      varied saved_usd, assert the column header testid is
      present, assert each row's saved_usd testid carries the
      formatted dollars, assert the sort header triggers a
      `saved_usd_desc` sort.
- [ ] Mobile (per 0011): at 375px viewport the new column
      collapses inline into the headline ("$420 · async
      streaming tails…"). The expanded row (per 0036's
      existing expand chevron) shows the full arithmetic
      tooltip text inline. At >=600px the column renders as a
      separate right-aligned monospace cell. Test: assert the
      existing mobile-portal text-level CSS contract at 375px
      (inline) and 600px (separate column).
- [ ] Empty-fleet behaviour: a fresh fleet with zero
      `lesson_credit` rows renders every existing 0036 lesson
      row with `saved_usd` as `--` (not `$0.00` — the dash
      communicates "no data yet" rather than "this lesson is
      worthless"). The arithmetic tooltip reads "no heals
      attributed yet — lessons earn savings as the fleet
      avoids known failures." Test: render the lessons portal
      against a freshly-initialised DB, assert every row's
      saved_usd renders as `--` and the tooltip carries the
      empty-fleet message.
- [ ] Quiet-hours integration (per 0030): when
      `quietHoursActive` is `true`, the SORT control is
      hidden (a midnight portal-open should not nudge the
      operator into re-sorting by dollars). The column
      itself remains visible. Matches the 0048 / 0050
      precedent: information visible, prompts suppressed.
      Test: stub quiet hours active, assert no
      `lessons-saved-usd-header` clickable testid; stub
      inactive, assert it's clickable.
- [ ] Performance: `lessonSavingsRollup(db, opts)` against a
      seeded fleet of 6 projects, 200 lesson_credit rows, and
      5,000 `run` rows completes in under 100ms (cache miss)
      and under 5ms (cache hit). Per LESSONS § "in-process
      startServer() tests need an empty-roots config + run-
      row seeds", server-boot tests plant a tmp `fleet-
      control.config.json` in cwd and restore on cleanup. Per
      LESSONS § "julianday() drifts ~10us per timestamp", any
      90-day window timestamp diff uses `strftime`
      decomposition. Test: seed the dataset, time both paths,
      assert thresholds (skip when `process.env.PERF !==
      "1"`).
- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-
      string composition. The additive field on `/api/lessons`
      does NOT count as a JSON-shape break per the AGENTS.md
      contract (the existing fields' types and meanings are
      unchanged; only NEW optional fields are added). No
      schema migration — composes existing `lesson_credit`,
      `control_audit`, `run`, `project` tables. Per LESSONS §
      "no backticks inside template-literal SQL strings",
      identifiers stay plain words.

## Out of scope

- A "lesson ROI" verdict per lesson ("this lesson is paying
  for itself 3x over"). The $ saved is the load-bearing
  number; verdicts invite threshold debate that does not
  cure operator pain.
- An attribution to specific COMMITS the lesson saved
  (commit-level provenance for each heal). 0042's
  attribution already names the PR; commit-level is finer-
  grained than the operator's question.
- A "lesson cost" (the cost in daemon ticks of the lesson
  being read at the start of each run). The cost is small
  and uniform; subtracting it from saved_usd would invite
  arguments without cure.
- An LLM-authored summary of "which lessons matter most."
  The ranking is deterministic — the operator picks the sort.
- Re-attributing historical heals against a freshly-added
  lesson. The ledger is forward-only per 0042's contract.
- A per-project lesson savings split ("this lesson saved
  almanac $200, courtiq $100"). The aggregate is the unit;
  per-project slicing is a follow-up if asked.
- An ntfy push when a lesson crosses a savings threshold
  (e.g. "lesson X just saved you $1000 cumulatively").
  Pull-only surface.
- A weighting by lesson recency ("recent lessons get a
  multiplier"). The window already truncates to 90 days;
  per-row recency weighting introduces parameters without
  cure.
- A cross-fleet (multi-operator) savings rollup. Single-
  fleet by design — the savings are the operator's, not the
  community's.

## Engineering notes

- `src/views.ts` — new `lessonSavingsRollup(db, opts)` helper
  next to the existing `lessonCreditRollup` (line ~4006). The
  helper REUSES the existing rollup's output as input,
  joining against `run` for the average-failed-ship cost.
  PRODUCER-VS-SPEC NOTE: grep `src/ingest/runs.ts` (or
  `src/ingest/index.ts`) for the literal value the producer
  writes for `run.outcome` on failed runs — `'failed'`,
  `'failure'`, `'fail'`, `'red'` are all plausible; the
  ingester decides. Same for `control_audit.action` — grep
  `src/control.ts` for the literal value written on a heal
  attempt. Per LESSONS 2026-06-05 "groomer prose can disagree
  with the schema; the schema wins", the producer's literal
  value is the contract. Per LESSONS § "node:sqlite's .all()
  needs `as unknown as T[]`", every row narrowing uses the
  double cast.
- `src/server.ts` — one new handler `GET /api/lessons/
  savings` (JSON, behind `read` scope). One amendment to the
  existing 0036 `/api/lessons` handler to JOIN the savings
  rollup and append the new `savings` field per row. Per
  LESSONS 2026-06-05 "break ingest↔server cache-invalidation
  cycles via a globalThis slot", the savings cache
  invalidation function MUST be registered on
  `globalThis.__fleet_lesson_savings_invalidate__` from
  `src/server.ts` and read lazily by `runIngestPass` AND by
  the heal-attribution pass in `src/control.ts` (or wherever
  `lesson_credit` rows are written — grep for the INSERT
  call site).
- `web/app.js` — extend the existing 0036 lessons portal
  view. The `saved_usd` formatting helper is `formatUsd(n:
  number): string` which already exists for 0035 / 0044 /
  0048 — PRODUCER-VS-SPEC NOTE: grep `web/app.js` for the
  exact helper name (it may be `fmtUsd`, `formatDollars`,
  `usd`). Reuse it.
- `web/style.css` — one selector group for the column
  header (sortable, clickable cursor), one for the
  monospace right-aligned cell, one for the tooltip on hover.
  Reuse existing CSS variables for color and font; do NOT
  add new ones.
- `tests/lesson-savings.test.ts` (new) — one `test(...)` per
  AC checkbox. Per LESSONS § "time-pinned tests must NOT
  derive seed timestamps from `new Date()`", every seed
  anchors to the test's pinned `now`. Per LESSONS § "in-
  process startServer() tests need an empty-roots config +
  run-row seeds", server-boot tests plant a tmp `fleet-
  control.config.json` in cwd and restore on cleanup. Per
  LESSONS § "anomaly tests need σ > 0 in the fixture", seed
  varied per-run failure costs so the average-failed-ship-
  cost computation is geometrically meaningful. Per LESSONS
  § "expose a build counter for cache-hit tests, not a
  fetcher swap", AC2 uses the build counter.
- Schema migration: NO new tables. Composes existing
  `lesson_credit`, `control_audit`, `run`, `project` tables.
- No new runtime deps. Pairs with 0036 (lessons portal —
  this is the data surface this ticket extends), 0042
  (lesson credit ledger — the attribution data this ticket
  dollarises), 0044 / 0048 (cost primitives — same shape of
  cost arithmetic), 0030 (quiet hours — suppresses the
  sort prompt).
