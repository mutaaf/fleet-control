---
id: 0042
title: Lesson credit ledger - attribute heal saves to the cross-fleet lesson that caught them
status: groomed
priority: P2
area: observability
created: 2026-06-07
owner: gtm-innovation
---

## User story

As a fleet operator scrolling the cross-fleet lessons page (0036)
wondering whether the lessons file is paying its keep, I want each
lesson row to show "saved N heals across M projects this month"
when the lesson's symptom substring actually matched a heal attempt
the fleet recovered from - so that the lessons file is no longer
passive memory but a live credit ledger I can SEE working, and so
that the next time an agent fixes itself by reading a lesson the
attribution lands on the lesson that earned the save.

## Why now (four lenses)

### Product Owner
0036 surfaces the cross-fleet lessons file in the portal but it is
read-only narrative - the operator sees the lessons but has no
signal about which ones are LOAD-BEARING vs which ones are stale.
Meanwhile the existing `control_audit` table records every `heal`
action and includes a `stdout_tail` of the failure that triggered
it. The fleet-control SQLite is the only place where (a) the
lessons file's symptom strings and (b) the heal-attempt stdout
tails coexist - a substring match between the two attributes
the heal to the lesson that documented the symptom. Pure
composition over existing tables (`control_audit`, plus the
already-parsed lessons from `loadCrossLessons()` per 0036). One
new tiny table `lesson_credit` carries the attribution
`(lesson_slug, lesson_date, heal_audit_id, matched_substring,
created_at)` so a backfill pass can attribute historical heals
in a single SQL pass. The credit count is read back as
"saved N heals across M projects (last 30 days)" inline next to
each lesson row in the 0036 portal view. The smallest meaningful
unit of value: ONE number per lesson, computed deterministically
from existing data, with NO new data source.

### Stakeholder
This is a STRUCTURAL moat play - one of the most distinctive ones
left to ship. Every other observability tool sees ONE PROJECT
(GitHub-native shows the PR's CI; Anthropic shows the project's
tokens). NONE of them see ACROSS projects, and NONE of them have
access to the operator's hand-curated lessons file as a symptom
dictionary. Fleet-control has BOTH. The lesson credit ledger turns
LESSONS.md from a wiki page into an active feedback loop: every
heal that pattern-matches an existing symptom credits the lesson,
the operator sees which lessons are paying their keep, and lessons
that NEVER credit anything are candidates for pruning during the
next groom pass. Per the cross-fleet courtiq lesson "lessons that
never re-fire are technical debt; lessons that re-fire weekly are
the moat," the ledger surfaces the distinction. The screenshot
worth sharing: the lessons page with a "saved 14 heals this month"
chip next to the entry that documented the symptom - proof that
the same operator's lessons file is doing measurable work across
the fleet.

### User (operator at 9am, looking at the lessons page)
On the existing 0036 `/lessons` page, each lesson row grows ONE
new inline chip on the right:

```
2026-05-26 - GitHub Actions can silently stop firing for a PR
                                   [saved 6 heals, 3 projects, 14d]
```

Tapping the chip drills into a small modal listing each credited
heal (project, PR number, ts, the matched substring excerpt).
Lessons with ZERO credits in the last 30 days show NO chip (a chip
that says "0 saves" is noise; absence is the signal). At the TOP
of the page a one-line summary: "Lessons earned 47 credits across
6 projects this month - top earner: GitHub Actions silently stop
firing (14 saves)." On phone the chip wraps under the lesson
title. The page works without JS for the read view; the modal
needs JS but degrades to a `/lesson/<id>` permalink for keyboard
nav.

### Growth
The screenshot worth sharing: "my lessons file caught 47 fleet-wide
recoveries last month - here's the page." That is a categorically
distinct artifact from anything other observability tools can
produce. A GitHub-native dashboard shows you THIS PR's CI; the
lesson credit ledger shows you "the symptom this lesson documented
hit the fleet 14 times and recovered each time." Per the cross-
fleet courtiq lesson "the share-worthy moment is the structural
impossibility for other tools," the credit ledger turns a passive
markdown file into a verifiable score card, which is the kind of
artifact that makes a prospective adopter ask "wait, how does it
know that?"

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: when
this spec names a column value literally (`control_audit.action =
'heal'`, `outcome = 'healed'`, etc.), the implementing dev MUST
grep `src/control.ts` and `src/ingest/runs.ts` for the producer's
actual casing before writing the SELECT. Per LESSONS 2026-06-05
"groomer prose can disagree with the schema; the schema wins":
the schema is the contract, this spec is a hint.

- [ ] New schema: `CREATE TABLE IF NOT EXISTS lesson_credit
      (lesson_slug TEXT NOT NULL, lesson_date TEXT NOT NULL,
      lesson_title TEXT NOT NULL, heal_audit_id INTEGER NOT NULL
      REFERENCES control_audit(id) ON DELETE CASCADE,
      project_slug TEXT NOT NULL, matched_substring TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY (lesson_slug,
      lesson_date, heal_audit_id))` added to the existing schema
      block in `src/db.ts`. The composite PK is also the
      idempotency guard: re-running the attribution pass on the
      same heal-audit row does not duplicate. An index on
      `(created_at DESC)` supports the "last 30 days" rollup.
      Per LESSONS § "no backticks inside template-literal SQL
      strings", identifiers stay plain. Test: open a fresh DB,
      assert the table exists with the right columns and PK;
      attempt a duplicate INSERT, assert SQLITE_CONSTRAINT.
- [ ] `src/lessons.ts` exports `extractSymptomPatterns(parsed:
      CrossLessonsLoadResult): Array<{slug: string, date: string,
      title: string, patterns: Array<string>}>`. For each lesson
      entry, derives 1-3 distinctive substrings from its title +
      body that are long enough (>= 12 chars) and specific enough
      (skip common English words via a hard-coded short stoplist
      `["the", "and", "with", "from", ...]`) to act as match
      keys. The substrings are LITERAL JS strings used in a JS
      `.includes()` test - never composed into SQL. When a lesson
      has no parseable date, it is skipped (the credit ledger
      needs `lesson_date` for the PK). Test: parse a fixture
      lessons file, assert the expected substrings; assert dated-
      less entries are skipped; assert no substring shorter than
      12 chars is emitted.
- [ ] `src/lessons.ts` exports `attributeHealsToLessons(db:
      DB, parsed: CrossLessonsLoadResult, now: Date, opts?:
      {windowDays?: number}): {credits_inserted: number,
      heals_examined: number}`. Walks `control_audit WHERE
      action = <heal-casing - grep src/control.ts FIRST per
      LESSONS 2026-06-05>` over the last 30 days (or
      `opts.windowDays`); for each heal, runs every lesson's
      patterns through `String.prototype.includes()` on the
      heal's `stdout_tail`; on first match (per heal) inserts
      one `lesson_credit` row attributing it to that lesson.
      Idempotent on re-run (the composite PK blocks duplicates).
      Per LESSONS § "shell-out modules need an injectable
      runner for tests" - no shell-out here; pure SQL + JS
      substring. Per LESSONS § "node:sqlite's .all() needs
      `as unknown as T[]`", every row narrowing uses the
      double-cast. Test: seed 5 heal-audit rows with stdout
      tails that match each of 3 lessons, run the attributor,
      assert the exact (lesson, heal) credit pairs; re-run
      against the same DB, assert `credits_inserted: 0`.
- [ ] `src/views.ts` exports `lessonCreditRollup(db, now: Date,
      opts?: {windowDays?: number}): {by_lesson: Array<{lesson_slug:
      string, lesson_date: string, lesson_title: string, saves:
      number, projects: number, last_seen: string}>, totals:
      {total_credits: number, total_projects: number, top_earner:
      {lesson_slug: string, lesson_date: string, lesson_title:
      string, saves: number} | null}, generated_at: string}`.
      Groups `lesson_credit` over the window. `saves` is the
      count of distinct `heal_audit_id`; `projects` is the count
      of distinct `project_slug`; `last_seen` is the max
      `created_at`. Returns lessons with zero credits OMITTED
      from `by_lesson` (the renderer treats absence as the
      no-chip signal). Per LESSONS § "julianday() drifts ~10us
      per timestamp" any timestamp diff uses strftime
      decomposition. Per LESSONS § "time-pinned tests must NOT
      derive seed timestamps from `new Date()`", every seed
      anchors to the pinned `now`. Test: seed 14 credits across
      3 lessons and 4 projects, assert the rollup numbers
      exactly; seed zero credits, assert empty `by_lesson` and
      `top_earner: null`.
- [ ] `GET /api/fleet/lesson-credits` returns the rollup shape
      from AC4. Requires `read` scope. Accepts an optional
      `?window=<days>` (1-90, default 30). The route triggers
      `attributeHealsToLessons()` on a cache miss so newly-
      landed heals get credited within the cache TTL without a
      separate cron path. Test: hit without auth -> 401; with
      `read` -> 200 with the expected shape; pass
      `?window=7`, assert the window narrows.
- [ ] Caching: the route response sets `Cache-Control:
      max-age=300` (5 min - heal-attempt rate is low; the
      rollup is cheap but the attribution write is the
      expensive bit). The handler memoises by
      `(window_days, latest_heal_audit_id, lessons_total)` -
      a three-value tuple that invalidates the moment a new
      heal lands OR the lessons file's total entry count
      changes (per the existing 0036 `loadCrossLessons()`
      `total` field). Per LESSONS § "in-process dedup sets
      need an explicit reset hook for tests", expose
      `_resetLessonCreditCacheForTests()` AND
      `_getLessonCreditCacheBuildsForTests()` per LESSONS §
      "expose a build counter for cache-hit tests, not a
      fetcher swap". Test: two calls within 5 min assert one
      build; insert a new heal-audit row, assert the next
      call rebuilds; mutate the lessons file's
      `total`, assert the next call rebuilds.
- [ ] `web/app.js` renders the rollup on the existing
      `/lessons` page (0036). Layout: ABOVE the per-project
      lesson sections, one summary line "Lessons earned N
      credits across M projects in the last 30 days - top
      earner: <title> (S saves)". Inline within each lesson
      row, when `saves > 0`, a chip "saved S heals, P
      projects" right-aligned at >=600px and wrapping under
      the title at 375px. Tapping the chip opens a modal
      listing the credited heals (project, ts, matched
      substring). Per LESSONS § "defence-in-depth secret
      redaction at the renderer boundary", every operator-
      visible string passes through `redactSecrets`. The
      summary line container has `data-testid="lesson-
      credit-summary"` and each chip has
      `data-testid="lesson-credit-chip"`. Test: stub the
      API with 3 lessons each scoring credits, assert the
      summary line and the chips; stub zero credits, assert
      the summary line shows "0 credits" and the chips are
      absent.
- [ ] Daemon hook: `src/daemon.ts` calls
      `attributeHealsToLessons()` once per daemon loop
      (default 60s interval per the existing daemon shape).
      Per the existing 0036 daemon hook for the lessons
      file, the attribute pass is skipped when the file is
      `oversized` or `source_present === false` (the
      existing guards already enforce these). Test: seed
      one heal-audit, run the daemon hook once, assert one
      credit row; run it again, assert zero new credits.
- [ ] Mobile: at 375px viewport the per-row chip wraps
      under the lesson title (not into the body); the
      summary line wraps gracefully to two lines.
      Horizontal scroll is forbidden (per 0011
      conventions). Test: assert via the existing mobile-
      portal text-level CSS contract at 375px and 600px.
- [ ] Quiet-hours integration: the credit ledger surface
      is a PULL view, not an alert. Per the existing 0030
      quiet-hours model, pull surfaces are not suppressed.
      The attribute pass on the daemon hook does not emit
      any notification (the existing 0036 daemon hook
      handles new-lesson notification; this hook adds
      attribution rows silently). Test: stub quiet hours
      active, run the attribute pass, assert no
      notification was dispatched (the existing
      `_resetDedupForTests` ntfy seam reports zero
      pushes).
- [ ] No new runtime deps. `tsc --noEmit` clean. No
      shell-string composition - all substring matches
      are JS `.includes()` calls, never composed into
      SQL. No JSON-shape break to any existing
      `/api/...` route - the new
      `/api/fleet/lesson-credits` is net-new; the
      existing `/api/fleet/lessons` payload is unchanged.
      Schema migration: one new table (`lesson_credit`)
      added to the existing SCHEMA block in `src/db.ts`.
      Per LESSONS § "no backticks inside template-
      literal SQL strings", identifiers stay plain.
      Per LESSONS § "in-process startServer() tests
      need an empty-roots config + run-row seeds",
      server-boot tests plant a tmp
      `fleet-control.config.json` in cwd and restore
      on cleanup.

## Out of scope

- AUTOMATIC lesson promotion / demotion based on credit
  count. The ledger is read-only signal; pruning is a
  groom-time human decision, not an auto-action.
- Cross-OPERATOR credit (sharing credit counts with
  other fleet-control users). The ledger is single-fleet
  by design; cross-operator surfaces are a separate
  product space.
- A "lesson suggestion" feature that proposes NEW
  lessons from un-attributed heal patterns. The credit
  ledger ATTRIBUTES known lessons; un-attributed heals
  are the operator's groom-time call. A future ticket
  may add an inbox kind for them; v1 does not.
- LLM-authored fuzzy matching between heal stdout and
  lesson body. The match is literal `String.includes()`
  for determinism and zero cost. Adding LLM matching
  would violate the zero-LLM-calls property.
- A per-lesson trend sparkline ("credits over time").
  v1 surfaces the rolling 30-day count only;
  sparklines are a follow-up.
- Surfacing un-credited lessons with a "stale" badge.
  Absence of credit is already the signal (no chip);
  adding a "stale" label invites the operator to delete
  lessons that might still be load-bearing for rare
  symptoms.
- A separate ntfy push for "your lesson just earned
  its 10th credit." Pull surface only; push would
  race the existing 0036 new-lesson notification.
- Per-lesson cost saving estimates ("this lesson saved
  you $14"). The credit count is denominated in heals,
  not dollars - dollars require an additional join to
  `run.cost_usd` and conflate "this heal would have
  been needed anyway" with "this lesson prevented the
  heal." Out of scope for v1.

## Engineering notes

- `src/db.ts` - one new `CREATE TABLE IF NOT EXISTS
  lesson_credit (...)` added to the SCHEMA template,
  plus one new index `CREATE INDEX IF NOT EXISTS
  lesson_credit_created_at ON lesson_credit(created_at
  DESC)`. Per LESSONS § "no backticks inside template-
  literal SQL strings", identifiers stay plain.
- `src/lessons.ts` - new
  `extractSymptomPatterns(parsed)` helper and new
  `attributeHealsToLessons(db, parsed, now, opts)`
  helper. The stoplist is a hard-coded module-level
  const. PRODUCER-VS-SPEC NOTE: grep
  `src/control.ts` for the actual `control_audit.action`
  string the production heal path writes (the spec
  hints at `'heal'` lowercase) before composing the
  SELECT. Per LESSONS 2026-06-05 "groomer prose can
  disagree with the schema; the schema wins" - the
  producer is the contract.
- `src/views.ts` - new `lessonCreditRollup(db, now,
  opts)` helper that joins `lesson_credit` with the
  cross-fleet lessons file (parsed via
  `loadCrossLessons()`) to surface the title inline.
  Per LESSONS § "node:sqlite's .all() needs
  `as unknown as T[]`", every row narrowing uses the
  double-cast. Per LESSONS § "julianday() drifts ~10us
  per timestamp", any timestamp diff uses strftime
  decomposition.
- `src/server.ts` - one new route
  `GET /api/fleet/lesson-credits`. Reuse the existing
  `read` scope middleware. The cache invalidation
  tuple is a three-value `(window_days,
  latest_heal_audit_id, lessons_total)`. Per LESSONS §
  "expose a build counter for cache-hit tests, not a
  fetcher swap" - expose
  `_resetLessonCreditCacheForTests()` and
  `_getLessonCreditCacheBuildsForTests()`.
- `src/daemon.ts` - extend the existing daemon loop
  to call `attributeHealsToLessons()` once per tick,
  guarded by the same `oversized` / `source_present`
  checks the existing 0036 lessons hook uses.
- `web/app.js` - extend the existing `/lessons` page
  render (per 0036) with the summary line and per-
  row chip. The chip's tap-handler opens a modal that
  reads `/api/fleet/lesson-credits?detail=<slug>:
  <date>` (a sub-shape of the same route, returning
  the per-credit detail rows). Per LESSONS §
  "defence-in-depth secret redaction at the renderer
  boundary", every operator-visible string passes
  through `redactSecrets`.
- `web/style.css` - one selector group for the chip
  layout (right-aligned at >=600px, wrapping at
  375px) and one for the summary line. Reuse existing
  CSS variables.
- `tests/lesson-credit.test.ts` (new) - one
  `test(...)` per AC checkbox. Per LESSONS § "time-
  pinned tests must NOT derive seed timestamps from
  `new Date()`", every seed anchors to the test's
  pinned `now`. Per LESSONS § "in-process
  startServer() tests need an empty-roots config +
  run-row seeds", server tests plant a tmp
  `fleet-control.config.json` in cwd and restore on
  cleanup. Per LESSONS § "anomaly tests need sigma >
  0 in the fixture" - not directly applicable; the
  spirit is to seed realistic match counts (multiple
  heals per lesson) rather than degenerate fixtures.
- No new runtime deps. Pairs with 0036 (the
  lessons page is the surface), 0027 (the cross-
  project failure correlation is the parallel pattern
  - both turn substring matches into structural
  signals), 0023 (the heal-attempts column on the PR
  card is the upstream signal), and 0008 (anomaly
  detection is the other place heal stdout gets
  read).
