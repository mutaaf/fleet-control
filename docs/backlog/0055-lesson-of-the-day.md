---
id: 0055
title: Lesson of the day — one cross-fleet lesson rotates onto the home card each morning so the operator gets a daily intellectual reward
status: groomed
priority: P1
area: portal
created: 2026-06-11
owner: gtm-innovation
---

## User story

As a fleet operator who opens the portal at 9am each morning (the
existing 0033 yesterday-glance habit), I want ONE cross-fleet lesson
rotated onto the home page each day — picked deterministically from the
~150 lessons in `~/.local/share/agent-fleet/CROSS_LESSONS.md` (per 0036
lessons portal), weighted by 0052's lesson-pays-for-itself savings so the
highest-value lessons surface more often — so that the daily portal-open
becomes an intellectual reward (today's tip: "redactSecrets on JSON
shreds your KEYS — cost the fleet $X / saved a future $Y if remembered")
instead of just a status check.

## Why now (four lenses)

### Product Owner

0036 (cross-fleet lessons portal view) makes the lesson archive
browseable on demand. 0052 (lesson-pays-for-itself ledger) attaches a
dollar value to each lesson. The two surfaces answer "where can I read
the lessons?" and "which ones paid for themselves?" — but neither
PUSHES a lesson into the operator's attention. The operator who is busy
shipping has no daily prompt to revisit the wisdom they've already
paid for. The smallest meaningful unit of value: ONE rotating card on
the home page, deterministic per-day, weighted by savings so the most
valuable lessons rotate up more frequently.

No new schema. No new ingest path. No new control surface. The
rotation is a pure function of `(day-of-year, lesson_savings ranking)`
— given the same day and the same savings ledger, every operator sees
the same lesson. The cache invalidates daily at midnight (per the
existing quiet-hours boundary in 0030). Subtraction beats addition: the
home page already has cards (0017 inbox, 0033 yesterday glance, 0040
riskiest PR, 0043 new-since-last-visit). This adds ONE more —
positioned as a "tip of the day" card the operator can dismiss for
the day with one tap.

PRODUCER-VS-SPEC NOTE: the existing 0036 helper that parses
CROSS_LESSONS.md exposes the lesson list (grep `src/lessons.ts` for
the parsed shape). 0052's `lessonSavingsRollup()` exposes `saved_usd`
per lesson. The rotation joins those two existing surfaces — no new
data structure.

### Stakeholder

Widens the moat on the RETENTION axis where 0033 (glance), 0038
(Monday catch-up), and 0037 (Friday wrap) already invest. Per the
cross-fleet courtiq lesson "the artifact that pushes itself into the
operator's daily attention is the one that compounds adoption"
(CROSS_LESSONS § courtiq Entries 2026-05-21 family on share
surfaces), the lesson-of-the-day is exactly that shape applied to
the operator's OWN accumulated wisdom. The screenshot worth sharing:
"my agent fleet reminds me of one of its own lessons every morning,
weighted by dollars saved" — a verdict only fleet-control's local
SQLite plus the cross-fleet lessons file can co-author. Pairs with
0052 (the savings ledger is the weight function), 0036 (the lesson
archive is the source), 0033 (the home-page card slot).

A subtle but important moat property: the rotation is
deterministic given the day-of-year, so two operators looking at
their fleets on the same morning may see DIFFERENT lessons (each
weighted by their OWN savings) — the cross-fleet lessons file is
shared, but the weighting is per-fleet, so the surface stays personal
even though the underlying corpus is communal.

### User (operator at 9am, opening the portal on a phone)

A new card appears at the top of the home page (above the inbox,
below the yesterday-glance), with `data-testid="lesson-of-the-day"`.
The card carries: a small "tip of the day" eyebrow label, the lesson
date (e.g. "2026-06-10"), the lesson title (one line, truncated to
~80 chars on mobile), a "$X saved by the fleet" badge (per 0052),
and an inline body excerpt (~120 chars, first sentence of the
symptom-cause-fix paragraph). One tap on the card navigates to
`/lessons` with the lesson pre-expanded (matches 0036's existing
expand surface). One tap on a small "dismiss" chevron hides the card
for the rest of the day (resurfaces tomorrow with a fresh lesson).

When the fleet has fewer than 5 cross-fleet lessons indexed (a
freshly-onboarded fleet), the card renders one honest sentence:
"Your fleet is still learning — lessons will surface here as the
agents accumulate them." (Honest empty-state per CROSS_LESSONS §
courtiq share-flow authenticity 2026-05-25 family.) The card NEVER
rotates within a single calendar day — refreshing the page shows
the same lesson until midnight local time, so the daily-reward
shape stays stable.

At 375px the card is full-width with the badge stacked beneath the
title. At >=600px the badge is right-aligned inline. Quiet hours
hides the dismiss chevron (a midnight visit shouldn't lose the
tip) and softens the "tip of the day" label to "tonight's lesson"
per the 0030 / 0053 precedent.

### Growth

The "show me" moment is the recurring habit. Per the cross-fleet
courtiq lesson "loss-accounting is the most-asked-for surface that
no commercial dashboard ships" (CROSS_LESSONS § courtiq Entries
2026-05-20 family), the inverse also holds: WISDOM-accounting (the
dollar-weighted lesson surface) is structurally impossible for any
tool that doesn't own both the cross-project lesson file and the
heal-attribution ledger. The lesson-of-the-day is the daily prompt
that converts the lesson archive (which the operator might open
once a week) into a daily reward (which the operator sees every
morning). Pairs with 0046 (onboard wizard — the freshly-onboarded
fleet sees the "still learning" empty state, which is itself a
"come back tomorrow" hook).

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: this
spec relies on the existing 0036 `lessonsForPortal()` (or similar
— grep `src/lessons.ts` for the actual exported helper name) and
0052's `lessonSavingsRollup()`. Per LESSONS 2026-06-05 "groomer
prose can disagree with the schema; the schema wins" the
implementing dev MUST grep both modules for the exact return
shape before composing the rotation helper.

- [ ] `src/lessons.ts` (or wherever 0036's helper lives — grep
      first) exports `lessonOfTheDay(db: DB, opts?: {now?: Date}):
      LessonOfTheDay | null` returning `{lesson_slug: string,
      lesson_date: string, lesson_title: string,
      lesson_excerpt: string, saved_usd: number,
      total_lessons_indexed: number, rotation_day_index: number}`.
      Returns `null` when fewer than 5 lessons are indexed
      (matches AC2 empty-state). The selection is deterministic
      given the calendar day (UTC): compute
      `day_index = floor(epoch_days(now))`, then pick the
      lesson at `day_index mod ranked_lessons.length` where
      `ranked_lessons` is the lesson list sorted by
      `saved_usd` DESC (stable secondary sort by `lesson_slug`
      ASC). The savings-weighting is implicit in the sort: the
      highest-savings lessons cluster at low indices in the
      rotation list, and the modular indexing means they
      naturally surface MORE OFTEN if you add a small bias —
      AC2 covers the bias. `lesson_excerpt` is the first
      sentence of the body (or first 120 chars whichever is
      shorter, ending on a word boundary). Per LESSONS § "node:
      sqlite's .all() needs `as unknown as T[]`", every row
      narrowing uses the double cast. Per LESSONS § "time-
      pinned tests must NOT derive seed timestamps from `new
      Date()`", every seed anchors to the pinned `now`. Test:
      seed 10 lessons with varied saved_usd, call with two
      different `now` values 1 day apart, assert two different
      lessons surface; call twice with the same `now`, assert
      identical output (deterministic).
- [ ] Weighting bias: the rotation favours higher-savings
      lessons via a "savings-decile bonus" — a lesson whose
      `saved_usd` is in the top decile gets sampled with
      double frequency (its rotation slot appears TWICE in the
      `ranked_lessons` list). Per LESSONS § "anomaly tests
      need σ > 0 in the fixture", the test fixture seeds a
      distribution where the top decile is geometrically
      distinct from the median — e.g. 10 lessons at
      $0/$5/$10/$15/$20/$25/$50/$100/$200/$1000. Over a 365-
      day simulated rotation, the top-decile lesson ($1000)
      surfaces ~2x more often than the median ($25). Test:
      seed the distribution, run `lessonOfTheDay` 365 times
      with consecutive `now` values, assert the top-decile
      lesson's surface count is >=1.6x and <=2.4x the median
      lesson's surface count (loose band accounts for the
      modular-rotation edge effects).
- [ ] Empty-state: when fewer than 5 lessons are indexed,
      `lessonOfTheDay()` returns `null` and the home-page card
      (AC5) renders one sentence "Your fleet is still
      learning — lessons will surface here as the agents
      accumulate them." with `data-testid="lesson-of-the-day-
      empty"`. No broken card layout, no missing testids.
      Test: render against a fleet with 0, 1, 2, 3, 4 lessons,
      assert the empty testid is present in each case; render
      against a fleet with 5 lessons, assert the regular
      card renders.
- [ ] Idempotency / caching: the helper memoises per tuple
      `(date(now) UTC, MAX(lesson_credit.created_at), COUNT(*)
      FROM lesson_credit, MAX(lessons file mtime))`. The
      `date(now)` term means the cache rolls over at midnight
      UTC without explicit invalidation. The `lesson_credit`
      pair (per LESSONS 2026-06-07 "the `pr` table has no
      surrogate `id`; proxy 'latest landed' via (MAX(fetched_
      at), COUNT(*))") catches new savings credits that
      could re-rank the rotation list. The lessons file mtime
      catches a fresh `fleet lessons-sync` writing the file.
      Per LESSONS § "in-process dedup sets need an explicit
      reset hook for tests", expose
      `_resetLessonOfTheDayCacheForTests()` AND
      `_getLessonOfTheDayCacheBuildsForTests()` per LESSONS §
      "expose a build counter for cache-hit tests, not a
      fetcher swap". Per LESSONS 2026-06-05 "break ingest↔
      server cache-invalidation cycles via a globalThis slot",
      the invalidation hook registers on `globalThis.
      __fleet_lesson_of_the_day_invalidate__`. Test: two
      calls within the same UTC day assert one build; advance
      `now` by 24h, assert the next call rebuilds; insert a
      new lesson_credit row, assert the next call rebuilds.
- [ ] `GET /api/fleet/lesson-of-the-day` returns the AC1
      shape as JSON. Requires `read` scope. Sets `Cache-
      Control: max-age=3600` (1h — the lesson rotates daily
      but the within-day call is identical). Per LESSONS §
      "defence-in-depth secret redaction at the renderer
      boundary" AND 2026-06-10 "redactSecrets on a JSON body
      shreds your KEYS" — scrub `lesson_title` and
      `lesson_excerpt` VALUES (which originate from the
      cross-fleet lessons file and could in principle carry
      an upstream-leaked token) BEFORE `JSON.stringify`,
      never the body string. Test: hit without auth → 401;
      hit with `read` against a seeded fleet → 200 with the
      shape; assert the response field names survive intact
      (the regression test for the 2026-06-10 lesson —
      `total_lessons_indexed` is 22 chars of letters+
      underscores, well into the redactor's danger zone).
- [ ] `web/app.js` adds a new home-page card rendered above
      the existing 0017 inbox card and below the 0033 glance
      card. Container `data-testid="lesson-of-the-day"`.
      Eyebrow label `data-testid="lesson-of-the-day-
      eyebrow"`. Title `data-testid="lesson-of-the-day-
      title"`. Excerpt `data-testid="lesson-of-the-day-
      excerpt"`. Savings badge `data-testid="lesson-of-the-
      day-saved"` formatted via the existing `usd()` helper.
      The card is wrapped in an `<a href="/lessons#<lesson_
      slug>">` so a tap navigates to the lessons portal with
      the lesson pre-expanded (matches 0036's hash anchor
      surface — PRODUCER-VS-SPEC NOTE: grep `web/app.js` for
      the existing lessons hash-route handling before relying
      on the anchor convention). Dismiss chevron carries
      `data-testid="lesson-of-the-day-dismiss"` and sets a
      `localStorage` flag `fleet:lesson-of-the-day-dismissed:
      <YYYY-MM-DD>` that suppresses the card until tomorrow.
      Per LESSONS § "defence-in-depth secret redaction at the
      renderer boundary", every operator-visible string passes
      through `redactSecrets` BEFORE composition into HTML.
      Test: stub a lesson-of-the-day response, assert all
      testids render with expected values; click the dismiss
      chevron, assert the card disappears AND the
      localStorage flag is set; advance the date in the stub,
      assert the card reappears.
- [ ] Mobile (per 0011): at 375px the card is full-width,
      title above badge, dismiss chevron in the top-right
      with at least 44px tap target. At >=600px the badge
      is right-aligned inline with the title. Test: assert
      the existing mobile-portal text-level CSS contract at
      375px (stacked badge) and 600px (inline badge).
- [ ] Quiet-hours integration (per 0030): when
      `quietHoursActive` is `true`, the dismiss chevron is
      hidden (a midnight visit shouldn't lose the tip) and
      the eyebrow label reads "tonight's lesson" instead of
      "tip of the day." The card itself, the title, the
      excerpt, and the badge all remain visible. Matches
      the 0048 / 0050 / 0053 precedent: information visible,
      prompts suppressed. Test: stub quiet hours active,
      assert no `lesson-of-the-day-dismiss` testid AND the
      eyebrow text contains "tonight"; stub inactive,
      assert dismiss is present AND eyebrow contains "tip".
- [ ] PWA / offline behaviour (per 0029): the lesson-of-
      the-day response is cacheable in the PWA service-
      worker's stale-while-revalidate path (matches the
      0029 contract). When offline, the card renders the
      last-cached lesson with a small "(cached)" suffix on
      the eyebrow `data-testid="lesson-of-the-day-cached-
      suffix"`. Test: stub the fetch to fail, assert the
      cached-suffix testid is present; stub the fetch to
      succeed, assert the suffix is absent.
- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-
      string composition. No JSON-shape break to any
      existing `/api/...` route (the new route is net-new).
      No schema migration — composes the existing
      `lesson_credit` table, the CROSS_LESSONS.md file, and
      the existing 0036 / 0052 helpers. Per LESSONS § "no
      backticks inside template-literal SQL strings",
      identifiers stay plain words.

## Out of scope

- An LLM-authored "summary of why this lesson matters"
  paragraph. The lesson body excerpt is the load-bearing
  text; LLM expansion invites both cost and hallucination.
- A "this lesson saved YOU $X" personalised tag attributing
  the savings to the operator's specific projects. v1 uses
  fleet-wide savings; per-project attribution is a follow-up
  (and would compete with 0053's graveyard surface).
- A "tomorrow's lesson preview" tease. The mystery is part
  of the daily reward; revealing tomorrow's pick erodes it.
- A push notification when the lesson rotates. Pull-only
  surface — same posture as the rest of the home cards.
- An "I learned something" reaction button per lesson. The
  engagement is the visit; reactions invite analytics that
  fleet-control does not collect.
- A per-operator history of "lessons seen so far." The
  rotation is stateless by design; tracking history would
  require a new table without curing any operator pain.
- An override surface ("pin this lesson to my home page
  forever"). Erodes the rotation; the operator can already
  navigate to `/lessons` to read any lesson at any time.
- A multi-fleet (cross-operator) "lesson of the day for the
  whole fleet community." Single-fleet by design — the
  weighting depends on per-fleet savings.

## Engineering notes

- `src/lessons.ts` — new `lessonOfTheDay(db, opts)` helper
  next to the existing 0036 portal helper. PRODUCER-VS-SPEC
  NOTE: grep `src/lessons.ts` for the existing parsed-
  lesson shape (the 0036 helper likely already returns a
  list of `{lesson_slug, lesson_date, lesson_title,
  lesson_body, project}` rows). Reuse that shape — the
  rotation helper composes the existing list with
  `lessonSavingsRollup()` from 0052 (per `src/views.ts:
  ~4154`). Per LESSONS § "node:sqlite's .all() needs `as
  unknown as T[]`", every row narrowing uses the double
  cast.
- `src/server.ts` — one new handler `GET /api/fleet/lesson-
  of-the-day` (JSON, behind `read` scope) near the existing
  `/api/fleet/lessons` routes (line ~2566, ~2709). Per
  LESSONS 2026-06-05 "break ingest↔server cache-invalidation
  cycles via a globalThis slot", the cache invalidation
  function MUST be registered on `globalThis.__fleet_lesson_
  of_the_day_invalidate__` from `src/server.ts` and read
  lazily by `runIngestPass` AND by the heal-attribution
  pass that writes lesson_credit rows (matches the 0052
  invalidation chain).
- `web/app.js` — new render function for the home-page
  lesson-of-the-day card. PRODUCER-VS-SPEC NOTE: grep
  `web/app.js` for the existing 0017 inbox / 0033 glance
  card render order; the new card lands BETWEEN them. The
  `usd()` formatter already exists (per the 0052
  implementation log) — reuse it. The `localStorage`
  dismiss key namespace is `fleet:lesson-of-the-day-
  dismissed:<YYYY-MM-DD>` — grep for the existing
  `fleet:` prefix to confirm the convention.
- `web/style.css` — one selector group for the lesson-of-
  the-day card (reuse the existing card structural CSS
  from 0017 / 0033). Reuse existing CSS variables for
  color and font; do NOT add new ones.
- `web/sw.js` — extend the service-worker cache
  allowlist (per 0029) to include `/api/fleet/lesson-of-
  the-day`. PRODUCER-VS-SPEC NOTE: grep `web/sw.js` for
  the existing cache-route allowlist; the new route lands
  alongside `/api/fleet/lessons`.
- `tests/lesson-of-the-day.test.ts` (new) — one
  `test(...)` per AC checkbox. Per LESSONS § "time-pinned
  tests must NOT derive seed timestamps from `new Date()`",
  every seed anchors to the test's pinned `now`. Per
  LESSONS § "in-process startServer() tests need an empty-
  roots config + run-row seeds", server-boot tests plant
  a tmp `fleet-control.config.json` in cwd and restore on
  cleanup. Per LESSONS § "anomaly tests need σ > 0 in the
  fixture", AC2's weighting fixture spreads saved_usd
  geometrically so the bias is measurable. Per LESSONS §
  "expose a build counter for cache-hit tests, not a
  fetcher swap", AC4 uses the build counter.
- Schema migration: NO new tables. Composes existing
  `lesson_credit`, `project`, and the CROSS_LESSONS.md
  file via the existing 0036 reader.
- No new runtime deps. Pairs with 0036 (lessons portal —
  the source corpus), 0052 (lesson-pays-for-itself ledger
  — the weighting function), 0033 (yesterday glance —
  shares the home-page card region), 0017 (inbox — the
  card sits above it), 0029 (PWA — the response is
  cacheable in the service worker), 0030 (quiet hours —
  suppresses the dismiss chevron).

## Implementation log

(Appended by the implementation-dev agent during execution.)
