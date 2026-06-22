---
id: 0069
title: Public lesson lineage page - one /lessons-public/<slug>/lineage URL traces a single cross-fleet lesson from its birth project through every later project it prevented a failure in with timestamps and dollars-saved per ripple so the moat-shaped artifact only fleet-control can author becomes the canonical "show me" link
status: shipped
priority: P1
area: observability
created: 2026-06-19
owner: gtm-innovation
---

## User story

As a fleet operator whose cross-fleet lessons have caught the same
TypeScript-cycle bug in three different projects over the last four
months, who today can see the AGGREGATE rollup on
`/lessons-public/<slug>` (0057) but cannot answer the journalist /
peer / recruiter question "show me the actual cause-and-effect chain"
because the rollup collapses time into one number, I want a single
public route `/lessons-public/<slug>/lineage` that renders the
lesson's TIMELINE: birth ("first authored 2026-04-12 after the
agent-fleet project hit error <signature>"), every project it later
prevented a re-occurrence in ("2026-05-03 caught at courtiq",
"2026-05-19 caught at fleet-control", "2026-06-11 caught at finance-
agent"), and the per-ripple hour-savings tally ("~1.5h saved per
catch, ~6h total"), so that when I paste this URL into a Hacker
News comment / Bluesky post / a peer's DM, the reader sees the
ACTUAL graph of how an autonomous fleet learns once and applies the
learning forever — the single piece of evidence no hosted
observability tool can author because no hosted tool has the
longitudinal cross-project SQLite the local kit accumulates.

## Why now (four lenses)

### Product Owner

0057 ships the `/lessons-public/<slug>` aggregate page. 0042 / 0052
ship the lesson_credit ledger. 0036 ships the cross-fleet lessons
portal view. 0055 ships the daily lesson-of-the-day rotator. 0063
ships the embeddable rotating widget. EVERY existing lesson surface
shows the AGGREGATE shape ("this lesson saved $X across N heals")
and none shows the TIMELINE. The journalist / peer / recruiter
question is always temporal: "but how did this actually unfold?"

The smallest meaningful unit of value: ONE new public route
`/lessons-public/<slug>/lineage` that renders a single page with:

1. **Header**: the lesson title (anonymised via the existing
   `anonymiseExcerpt` from 0058 - PRODUCER-VS-SPEC NOTE per
   LESSONS 2026-06-13: the helper is PRIVATE inside views.ts;
   reuse it inline, do NOT introduce a `from "./lessons.ts"` or
   `from "./views.ts"` import that would create a cycle). The
   lesson's birth date and birth project alias.

2. **The timeline**: ordered list of events:
   - Event 0: lesson AUTHORED (the first row in
     `lesson_credit` for this lesson_slug + lesson_date, OR
     when no credit row exists, the lesson's own
     `lesson_date` field as the synthetic birth event).
     Project alias derived from `project_slug` -> `project-a`
     mapping per 0013 anonymisation discipline.
   - Events 1..N: lesson APPLIED at project-b on T1, applied
     at project-c on T2, etc. Ordered by `created_at` ASC.
     Each event surfaces `~Xh saved` derived from the same
     `lessonSavingsRollup` math (heal_count *
     average_failed_ship_cost as a TIME figure via the
     existing 0048 hours-per-PR knob) so the timeline matches
     the rollup totals exactly.

3. **The totals strip** at the top: `N catches across M
   projects, ~Xh saved cumulative`. Same numbers as the
   aggregate page but framed as a SUM, not an average.

4. **The "what it teaches" excerpt**: the anonymised lesson
   body (re-using the existing 0058 `anonymiseExcerpt`
   inline copy in views.ts per LESSONS 2026-06-13).

5. **The footer**: "this lineage was authored entirely from
   one operator's local SQLite - no LLM, no cloud, no fleet
   meta-API. Install fleet-control to grow your own
   cross-project memory" + a single install link. Per LESSONS
   2026-06-11 the install CTA is suppressed under quiet
   hours per the existing pattern.

6. **OG card sibling** at `GET /og/lessons-public/<slug>/
   lineage.svg` mirrors the 0061 hand-rolled posture: 1200x630
   SVG showing the lesson title, a sparkline of catches over
   time (3-5 dots with dates underneath), the cumulative
   savings figure. Per LESSONS 2026-06-12 the SVG carries
   `data-testid="lineage-og-title"`.

PRODUCER-VS-SPEC NOTE per LESSONS 2026-06-05: the implementing
dev MUST grep `src/views.ts` for the EXISTING
`lessonSavingsRollup` helper (per 0052) and the existing
`lessonsPublicPayload` helper (per 0057) so the lineage helper
REUSES the same SQL shape and the totals strip matches the
aggregate page byte-for-byte. The lineage helper is a NEW
function alongside `lessonsPublicPayload` in views.ts, NOT a
parallel SQL surface. Per LESSONS 2026-06-13 the helper does
NOT introduce a new `from "./lessons.ts"` import; it reuses
the inline `anonymiseExcerpt` already living in views.ts
(added in 0058 per the lesson). Per LESSONS 2026-06-15 on
first-meaningful-month pivots - when the lesson has < 2 catch
events the lineage page renders an honest "this lesson is
freshly authored - check back after it has caught a
re-occurrence" empty state (the timeline is a SHAPE that
requires >= 2 events; a singleton catch is the aggregate page's
job).

### Stakeholder

Widens the moat on the LONGITUDINAL-CROSS-PROJECT-MEMORY axis
where no competitor can structurally compete. The reasoning:

- A hosted observability tool sees ONE project at a time per
  customer (or N projects but each siloed by tenant). It
  cannot author "this lesson born at project A prevented the
  bug at project B" because the cross-project edge is
  outside its data model.
- A research notebook (Jupyter, Obs) sees cross-project data
  but is HUMAN-CURATED - the operator writes the lineage by
  hand, which means it never gets written.
- fleet-control's `lesson_credit` table (0042) is the only
  surface in the ecosystem that AUTOMATICALLY records "this
  heal in project B cited a lesson from project A". The
  lineage page is the public visible artifact of that
  unique data model.

The hosted-competitor structural gap: any hosted tool that
WANTED to ship the same surface would need to land an SDK on
every operator's local heal-audit pipeline AND a cross-tenant
shared lesson library AND a credit-attribution model. That is
a full product. fleet-control already has all three because
the local SQLite has been collecting them since day one of
0042.

Per the cross-fleet courtiq lesson "the moat artifact is the
one piece of evidence the operator can show that competitors
cannot replicate - look for SHAPES the local data accumulates
that hosted tools structurally cannot" (CROSS_LESSONS section
courtiq Entries 2026-05-21 family on moat-evidence), the
lesson lineage IS that artifact: a self-explaining
cause-and-effect graph drawn from the operator's own DB, with
no AI prose, no curation, no editorial labour.

The "show me" moment worth a screenshot: a tweet thread
sharing `/lessons-public/typescript-cycle-import/lineage`
with the screenshot's caption "look what my autonomous fleet
remembered across 4 projects over 3 months - this is one of
~150 lessons it carries". Every reader who clicks lands on
the empirical proof.

Pairs with 0057 (public lesson archive - parent surface), 0042
/ 0052 (lesson_credit ledger - source data), 0036 (cross-fleet
portal view - the operator-side surface that links into the
new lineage page), 0061 (OG image infra), 0064 (rate-limit),
0058 (anonymisation discipline - reuses the inline helper).

### User (operator at 9am, looking at the portal)

Three operator scenarios:

1. **Daily glance** (zero impact): the portal home is
   UNCHANGED. The lineage page is a public artifact, not an
   operator-facing card. The operator never lands on
   `/lessons-public/<slug>/lineage` from their own daily
   rhythm - they paste the URL when sharing.

2. **The share moment** (the high-leverage moment): operator
   sees the lesson-of-the-day card (0055) on their home page,
   thinks "this is a great example of cross-project memory",
   clicks through to `/lessons-public/<slug>` (0057), clicks
   the new "see how this lesson traveled" link to the
   lineage page, copies the URL, pastes into Bluesky / Slack
   / a peer DM.

3. **The receiver's path** (the conversion): the receiver
   clicks the lineage URL, lands on the timeline page,
   reads the 4-event trail, reaches the footer, clicks
   "install fleet-control to grow your own cross-project
   memory". The lineage page IS the demo.

Per LESSONS 2026-06-11 the renderer-direct seam
`_renderLessonLineageForTests(payload, opts)` exercises the
quiet-hours / empty-state / over-2-events branches without
cwd config mutation.

### Growth

The growth bet: every lineage page is a HIGH-INTENT
ACQUISITION SURFACE because the reader is reading it BECAUSE
the operator pasted a SPECIFIC LESSON they cared about. Per
the cross-fleet courtiq lesson "the conversion lift on a
share is proportional to the specificity of the artifact -
generic public pulses convert at 0.5%; specific cause-and-
effect artifacts convert at 3-4%" (CROSS_LESSONS section
courtiq Entries 2026-05-21 family on specificity-as-
conversion), the lineage page is the most-specific
surface fleet-control has ever shipped.

A second growth surface: SEO. Each lineage page carries a
unique anonymised slug + the timeline as semantic HTML
(`<ol><li>`). A search engine indexing
`/lessons-public/typescript-cycle-import/lineage` lands
the operator's autonomous-fleet memory in the long tail
for that exact error string. The 0057 ticket already
established the SEO posture for the aggregate page;
lineage extends it to the cause-and-effect axis.

Pairs with 0057 (parent SEO surface), 0061 (OG card),
0063 (lessons widget - could link to lineage in v2),
0064 (rate-limit).

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] New helper `lessonLineagePayload(db, slug, now)` in
      `src/views.ts` returns `{ slug, title, anonymisedTitle,
      birthDate: string, birthProjectAlias: string, events:
      [{ kind: "author" | "catch", at: string,
      projectAlias: string, healAuditId: number | null,
      hoursSaved: number }], totals: { catches: number,
      projects: number, hoursSavedTotal: number },
      asOf: string, version: 1 }`. The helper SELECTs from
      `lesson_credit` WHERE `lesson_slug = ?` ORDER BY
      `created_at ASC`. The birth event is synthesised from
      the EARLIEST `lesson_credit` row OR (when zero rows
      exist) returns `null`. The hoursSaved per catch is
      derived from the EXISTING 0052 `lessonSavingsRollup`
      math: `hoursPerPr` from the 0048 worth_it knob (default
      1.0) times the per-event count (1, since each catch is
      one credit row). PRODUCER-VS-SPEC NOTE: grep
      `src/views.ts:lessonSavingsRollup` and reuse the
      worth_it hourly-rate read so the totals strip matches
      the aggregate page. Test: seed 4 lesson_credit rows
      spanning 3 distinct project_slug values over 90 days;
      assert `events.length === 5` (1 author + 4 catches),
      `totals.catches === 4`, `totals.projects === 3`,
      `totals.hoursSavedTotal === 4.0`.

- [ ] Empty-state branch: when the lesson has 0 catch rows
      `lessonLineagePayload` returns null. Test: invoke with
      a slug that has no lesson_credit rows; assert null.

- [ ] Singleton-catch branch: when the lesson has exactly 1
      catch row, the page renders an honest "this lesson is
      freshly authored - check back after it has caught a
      re-occurrence" empty-state copy (per LESSONS 2026-06-15
      on threshold-shaped operator-facing copy). The render
      carries `data-testid="lineage-warming-up"`. Test: seed
      1 lesson_credit row; render the page; assert the
      testid is present AND `data-testid="lineage-timeline"`
      is ABSENT.

- [ ] New public route `GET /lessons-public/<slug>/lineage`
      in `src/server.ts` mounts BEFORE the `/api/` auth
      gate (per LESSONS 2026-06-15 the static-grep ordering
      assertion anchors on `if (path.startsWith("/api/"))`
      NOT a comment). The route 404s when
      `lessonLineagePayload(db, slug, now) === null`. Test:
      hit the route with a slug that has 0 catches; assert
      404. Hit with a 4-catch seed; assert 200 +
      Content-Type `text/html; charset=utf-8` + the
      response body contains `data-testid="lineage-
      timeline"` with 5 children (1 author + 4 catches).

- [ ] OG card sibling `GET /og/lessons-public/<slug>/
      lineage.svg` renders 1200x630 SVG with the lesson
      title, a sparkline of catches over time (5 dots), the
      cumulative `~Xh saved` figure, the footer "powered by
      fleet-control". Content-Type `image/svg+xml`. Per
      LESSONS 2026-06-12 the SVG carries
      `data-testid="lineage-og-title"` and the test anchors
      on the testid not a body substring. 404s when the
      lineage payload is null. Test: hit with a 4-catch
      seed; assert 200 + the testid + 5 `<circle>` dots in
      the SVG body.

- [ ] OG meta tags on the HTML page: `<meta
      property="og:image" content="<host>/og/lessons-
      public/<slug>/lineage.svg">` + `<meta name="twitter:
      card" content="summary_large_image">` + `<meta
      property="og:title">` + `<meta property="og:
      description">`. The og:image URL uses the
      `cfg.operator?.publicHost` field per the existing
      0061 / 0065 composition pattern (absolute when set,
      relative falling back to the Host header). Test:
      assert all four meta tags present + og:image URL
      shape.

- [ ] Cross-link from the aggregate page: the existing
      `/lessons-public/<slug>` rendered HTML (0057) grows
      ONE new line "see how this lesson traveled across
      <N> projects -> lineage" linking to
      `/lessons-public/<slug>/lineage` ONLY when
      `lessonLineagePayload(db, slug, now)?.totals.catches
      >= 2` (the singleton-and-empty cases hide the link).
      The link carries `data-testid="lessons-public-
      lineage-link"`. Test: render the aggregate page for
      a slug with 4 catches; assert the testid present.
      Render for a slug with 0 catches; assert ABSENT.

- [ ] Rate-limit prefix: the existing `/og/` and
      `/lessons-public/` prefixes already match the
      `isRateLimitedPath` family. NO new prefix needed -
      the existing `path.startsWith("/og/")` covers the OG
      sibling and `path.startsWith("/embed/")` does NOT
      cover `/lessons-public/`. PRODUCER-VS-SPEC NOTE:
      grep `src/rate_limit.ts:isRateLimitedPath` to confirm
      `/lessons-public/` is in the OR chain (it should be
      already from 0057; if not, add it as part of this
      ticket). Test: hit `/lessons-public/<slug>/lineage`
      61 times from a simulated remote IP; assert the 61st
      returns 429.

- [ ] Quiet-hours posture: per LESSONS 2026-06-11 the
      `_renderLessonLineageForTests(payload, opts)`
      renderer-direct seam exercises the quiet-hours
      branch without cwd mutation. When
      `quietHoursActiveAnywhere(cfg, now)` returns true,
      the footer "install yours" CTA is replaced with a
      softer "powered by fleet-control" caption. Test:
      drive `_renderLessonLineageForTests` with
      `quietHoursActive: true`; assert
      `data-testid="install-cta"` ABSENT.

- [ ] Cache + invalidation: the lineage payload is memo-
      cached for 60s keyed by `slug`. Per LESSONS
      2026-06-07 the invalidation tuple uses
      `(MAX(lesson_credit.created_at WHERE lesson_slug=?),
      COUNT(*) FROM lesson_credit WHERE lesson_slug=?)`.
      Hook on `globalThis.__fleet_lesson_lineage_
      invalidate__` registered from `src/server.ts` on
      module load and consumed lazily by
      `attributeHealsToLessons` (per the existing 0055
      pattern). Test: render the lineage, insert a new
      lesson_credit row for the same slug, assert the
      next render reflects the new event within the next
      invalidation tick.

- [ ] tsc --noEmit clean. No new runtime deps. No shell-
      string composition. No JSON-shape break to
      `/api/...` routes. No schema migration - the
      lineage is DERIVED from existing `lesson_credit`
      rows. Per LESSONS 2026-06-13 the helper does NOT
      introduce a new `from "./lessons.ts"` import in
      views.ts; the anonymisation reuses the existing
      private `anonymiseExcerpt` helper in views.ts.
      Per LESSONS 2026-06-11 character-window source
      greps - the new helper's leading comment block
      uses PLAIN PROSE for sibling-helper-grep-
      vulnerable identifiers. Per LESSONS 2026-06-15
      static "route mounted before /api/" greps anchor
      on `if (path.startsWith("/api/"))`.

## Out of scope

- A WRITE surface to manually annotate a lineage event
  ("this catch was the most impactful"). v1 is purely
  derived from `lesson_credit`; editorialising the
  timeline introduces opinion the data model deliberately
  avoids.
- A MULTI-LESSON BRAID view (two lessons that share a
  signature ancestor). Requires a lesson-graph traversal
  that the v1 helper does not author. Out of scope.
- A LIVE-UPDATING timeline (the page auto-refreshes when
  a new catch lands). v1 is static-as-of-cache; the 60s
  memo is enough for share-paste workflows.
- A PER-PROJECT BREAKDOWN ("show me only catches in
  project-b"). The timeline IS the breakdown; a query
  filter is feature-creep for ~0% conversion lift.
- A NON-ANONYMISED ATTRIBUTED variant for the operator's
  own use. The lineage is PUBLIC-SHAPED only; the
  operator who wants attributed lineage uses the
  existing 0042 ledger surface via the portal.
- A SEARCH-BY-SIGNATURE landing page that finds the
  lineage by the error string. Future ticket if the SEO
  hits demand it; v1 ships the canonical URL only.
- A LESSON BIRTH-CERTIFICATE artifact (a permalink
  certifying "operator A first authored this lesson on
  date D"). Out of scope; the lineage page surfaces the
  birth event but does NOT issue an attestation.

## Engineering notes

- `src/views.ts` - new helpers `lessonLineagePayload(db,
  slug, now)`, `renderLessonLineagePage(payload, opts)`,
  `_renderLessonLineageForTests(payload, opts)`,
  `renderLessonLineageOgSvg(payload)`,
  `_renderLessonLineageOgSvgForTests(payload)`. Per
  LESSONS 2026-06-13 the helpers live ALONGSIDE
  `lessonsPublicPayload` (0057 sibling). Reuse the
  EXISTING inline `anonymiseExcerpt` in views.ts (no
  new import edge). Reuse the EXISTING `lessonSavingsRollup`
  per-catch hour-savings math via direct call to
  `worth_itHoursPerPr(cfg)` per LESSONS 2026-06-05 (the
  helper signature is the producer; the ticket prose
  is the spec - reconcile by grepping the function before
  authoring).
- `src/views.ts` - extend `renderLessonsPublicPage` (the
  existing 0057 renderer) with the new cross-link line
  ONLY when `lessonLineagePayload(db, slug, now)
  ?.totals.catches >= 2`. PRODUCER-VS-SPEC NOTE: grep
  the 0057 renderer for the exact function name before
  the extension.
- `src/server.ts` - new public route handlers `GET
  /lessons-public/<slug>/lineage` and `GET /og/lessons-
  public/<slug>/lineage.svg`. Mount BEFORE the
  `/api/` auth gate alongside `/lessons-public/`
  (existing) and `/og/` (existing). Per LESSONS
  2026-06-15 the static-grep ordering anchors on
  `if (path.startsWith("/api/"))`.
- `src/server.ts` - register `globalThis.
  __fleet_lesson_lineage_invalidate__` on module load
  per LESSONS 2026-06-05. The hook is invoked from
  `attributeHealsToLessons` in `src/lessons.ts` (the
  existing 0055 lesson-of-the-day pattern is the
  precedent).
- `src/rate_limit.ts` - confirm `/lessons-public/` is in
  the `isRateLimitedPath` OR chain (it should be from
  0057). If missing, add it.
- `tests/lesson-lineage.test.ts` (NEW) - one
  `test(...)` per AC checkbox above. Per LESSONS
  2026-05-29 every test pins `now` and seeds
  timestamps off the same anchor. Per LESSONS
  2026-06-13 per-candidate fixtures clear BOTH the
  per-event minimum AND the global empty-state gate
  (so a 4-catch fixture satisfies the >= 2-event
  threshold for the cross-link AND the >= 2-event
  threshold for the timeline shape).
- `README.md` - one new bullet under the
  `/lessons-public/<slug>` subsection documents the
  new `/lineage` sibling.
- Schema migration: NO. The lineage is derived
  entirely from existing `lesson_credit` rows.
- No new runtime deps. Pairs with 0057 (parent
  surface), 0042 / 0052 (source data), 0061 (OG
  infra), 0064 (rate-limit), 0058
  (anonymisation discipline), 0036 (cross-fleet
  portal view).

## Implementation log

- 2026-06-19: status -> in-progress on branch feat/0069-lesson-lineage-public-page.
  Plan: (a) tests/lesson-lineage.test.ts with one test() per AC checkbox;
  (b) new helpers `lessonLineagePayload`, `renderLessonLineagePage`,
  `_renderLessonLineageForTests`, `renderLessonLineageOgSvg`,
  `_renderLessonLineageOgSvgForTests` in src/views.ts alongside the existing
  `lessonSavingsRollup` (0052) and `lessonSavingsByProject` (0056) family;
  (c) new public routes GET /lessons-public/<slug>/lineage and
  GET /og/lessons-public/<slug>/lineage.svg in src/server.ts mounted BEFORE
  the `if (path.startsWith("/api/"))` auth gate; (d) globalThis slot
  `__fleet_lesson_lineage_invalidate__` registered from src/server.ts and
  consumed lazily from src/lessons.ts attributeHealsToLessons; (e) extend
  the existing 0057 `renderLessonsPublicPermalink` with a cross-link to
  the lineage page when `totals.catches >= 2`; (f) extend
  `isRateLimitedPath` to include `/lessons-public/` (the 0057 surface
  did not add it - confirmed by grep src/rate_limit.ts:408-413);
  (g) README bullet under the Server routes - Read table.
  Reconciliation notes per LESSONS:
  - 2026-06-13: NO new `from "./lessons.ts"` import in views.ts. The
    anonymisation reuses the existing private `anonymiseExcerpt` already
    in views.ts (at views.ts:7132, added by 0058).
  - 2026-06-05: the 0057 helper is named `lessonsPublicArchive` (not
    `lessonsPublicPayload` as the spec prose says). lineage helper uses
    its own name; the totals-strip arithmetic uses the existing
    LESSON_SAVINGS_FLOOR_USD floor + cfg.worth_it.hourly_rate_usd
    pattern so the rollup numbers stay consistent with 0052.
  - 2026-06-07: cache invalidation tuple is
    (MAX(lesson_credit.created_at WHERE lesson_slug=?),
     COUNT(*) FROM lesson_credit WHERE lesson_slug=?) - lesson_credit
    has composite PK (lesson_slug, lesson_date, heal_audit_id), no
    surrogate id.
  - 2026-06-11: helper comment block keeps every sibling-helper
    identifier in PLAIN PROSE (no backticks) so 0052 character-window
    grep tests cannot leak across the helper boundary.
  - 2026-06-15: cross-link uses `data-testid` attribute (not
    greedy `id=` regex).
  - 2026-06-11: `_renderLessonLineageForTests(payload, opts)` is the
    renderer-direct seam for the quiet-hours branch; no cwd config
    mutation in any test.
