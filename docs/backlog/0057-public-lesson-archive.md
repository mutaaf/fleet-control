---
id: 0057
title: Public lesson archive — anonymised /lessons-public surface where a stranger Googling a node:sqlite error lands and downloads fleet-control
status: in-progress
priority: P2
area: portal
created: 2026-06-11
owner: gtm-innovation
---

## User story

As an external developer Googling "node:sqlite .all() Conversion of type
Record SQLOutputValue" at 11pm during a debugging session, with NO
knowledge of fleet-control's existence, I want the search to surface a
public anonymised lesson archive at `/lessons-public` (no auth, indexable
by crawlers) where the relevant lesson is rendered with full body text —
"the symptom you're staring at, the cause you haven't spotted, the fix
you need" — and a single footer line "this lesson was authored by an
autonomous agent fleet running fleet-control — install yours at
<github-url>", so that the moat-deepening cross-fleet wisdom doubles as
an acquisition surface: I land on the page, my problem is solved, and I
discover a tool whose value is structurally undeniable because it just
saved me 20 minutes.

## Why now (four lenses)

### Product Owner

0036 (cross-fleet lessons portal) renders the lessons file for the
LOGGED-IN operator. The lessons themselves are extraordinarily valuable
("redactSecrets on JSON shreds your KEYS", "node:sqlite's .all() needs
`as unknown as T[]`", "GitHub Actions can silently stop firing for a
PR") and the operator's fleet has authored ~150 of them over time. But
the value is locked behind the operator's admin token — every visit
requires auth, no crawler can index them, no external developer can
land on one.

This ticket opens a NEW public route `/lessons-public` (and the per-
lesson permalink `/lessons-public/<lesson-slug>`) that exposes the same
cross-fleet lessons file, ANONYMISED per 0013's discipline (no project
names, no operator metadata, no per-PR identifiers in the lesson
bodies — only the symptom-cause-fix prose plus the date and a generic
"agent-fleet" project tag). Pure read. No new schema. No new ingest
path. The smallest meaningful unit of value: ONE public route exposing
content the fleet already authors.

PRODUCER-VS-SPEC NOTE: per LESSONS 2026-06-10 "redactSecrets on a
JSON body shreds your KEYS" — the anonymisation pass must scrub
operator-supplied VALUES (project slugs, branch names embedded in
lesson bodies), not the structural HTML. Grep `src/lessons.ts` for the
existing 0036 parsed-lesson shape before writing the anonymiser.

### Stakeholder

Widens the moat on the SEO acquisition axis where no other surface
invests. 0041 (receipts) and 0050 (year-in-review) are share-when-
operator-decides surfaces; 0015 (status badge) is a passive impression
surface; 0051 (calculator) is a direct-link conversion surface. None
of them are CRAWLER-INDEXED. The lesson archive is the first fleet-
control surface designed for inbound search traffic — a developer
debugging a specific failure mode lands on a lesson that solves it,
and the only attribution is "an autonomous agent fleet authored
this lesson while debugging a similar failure — try fleet-control
yourself."

Per the cross-fleet courtiq lesson "any public artifact that helps
a stranger BEFORE they install your tool is the cheapest
acquisition surface" (CROSS_LESSONS § courtiq Entries 2026-05-21
family on share-flow), the lesson archive is exactly that artifact
applied to the rarest kind of content — debugging wisdom for
specific failure modes that NO blog post will ever write (because
the failures are esoteric and the blog reader-base is too small to
justify the post). Fleet-control's agents wrote these lessons as a
SIDE EFFECT of their actual work; publishing them costs nothing
and adds search-engine surface.

The screenshot worth sharing: a Google SERP showing
`/lessons-public/2026-06-10-redactsecrets-on-json` as the top
result for "redactSecrets json keys mangled" — a structurally
impossible surface for any tool that doesn't author lessons from
real failures.

### User (external developer at 11pm, debugging)

Two surfaces:
1. `/lessons-public` — a single long single-column scroll, server-
   rendered HTML (NO `<script>`), every lesson title visible as a
   header, the date prefix, and the body text below. Search-engine
   friendly: every lesson has a stable `<h2 id="<lesson-slug>">`
   anchor. A header at the top: "lessons authored by an autonomous
   agent fleet running fleet-control — N lessons across M months."
   Footer: "get fleet-control at <github-url>." NO operator data,
   NO project names, NO admin token, NO control surface.
2. `/lessons-public/<lesson-slug>` — a per-lesson permalink page,
   the SAME content but with the single lesson rendered as the
   primary content, suitable for sharing on a forum thread or
   linking from a blog post answer.

The pages are mobile-first (375px, one column, no horizontal
scroll). They work on a flaky cellular connection because no
JavaScript runs. Each page sets a `<meta name="robots"
content="index,follow">` to opt into crawler indexing AND a
`<link rel="canonical">` to the permalink form so the index page
and the permalink page don't compete for ranking.

Crucially: the lesson body PROSE is preserved verbatim — that's
the SEO content. The anonymisation strips operator-supplied
proper nouns (project slugs, branch names, PR numbers, repo
paths) but leaves the technical symptom/cause/fix language
intact. Example: a lesson titled "node:sqlite's .all() needs `as
unknown as T[]` when narrowing" keeps its full body; a sentence
that mentions "while shipping ticket 0012 (weekly digest)" gets
anonymised to "while shipping an agent ticket."

### Growth

The "show me" moment is the inbound search-traffic conversion.
Per the cross-fleet courtiq lesson "the prospect who arrives with
a specific problem solved is 10x more likely to convert than the
prospect who arrives with curiosity" (CROSS_LESSONS § courtiq
Entries 2026-05-21 family), the lesson archive is the highest-
intent acquisition funnel fleet-control can author. Pairs with
0041 (receipts, the operator-chosen public artifact) and 0051
(calculator, the curiosity-driven prospect's first stop) — the
lesson archive is the THIRD public surface, designed for a
distinct entry point (search rather than direct link).

The "this works" moment is when the prospect's debugging session
gets unstuck by a lesson the agents wrote, and the prospect
notices that the SAME tool that authored the lesson could prevent
future versions of the same bug — the install motivation is
self-evident.

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: per
LESSONS 2026-06-05 "groomer prose can disagree with the schema;
the schema wins" the implementing dev MUST grep `src/lessons.ts`
for the existing 0036 lesson-list shape and the parsed body
format before writing the anonymiser. Per LESSONS 2026-06-10
"redactSecrets on a JSON body shreds your KEYS" — the
anonymisation logic scrubs lesson body VALUES, never the
structural HTML or the lesson title.

- [ ] `src/lessons.ts` exports `lessonsPublicArchive(opts?:
      {now?: Date, projectAliasMap?: Record<string,
      string>}): LessonsPublicArchive` returning
      `{generated_at: string, total_lessons: number,
      earliest_lesson_date: string, latest_lesson_date:
      string, lessons: Array<{lesson_slug: string,
      lesson_date: string, lesson_title: string,
      lesson_body_anonymised: string, project_alias:
      string}>}`. The function reads
      `~/.local/share/agent-fleet/CROSS_LESSONS.md` via the
      existing 0036 reader and ANONYMISES each lesson body
      by:
      - replacing any project slug (from the operator's
        actual project list) with a stable `project-N`
        alias (per the 0013 anonymise() shape).
      - replacing any branch name matching
        `(feat|chore|eng)/[A-Za-z0-9/_-]+` with
        `<branch>`.
      - replacing any PR number `#NNN` with `#NNN` (the
        PR number is generic; not anonymised).
      - replacing any absolute filesystem path under
        `/Users/` or `/home/` with `<path>`.
      - replacing any ticket ID reference `ticket NNNN`
        with `an agent ticket`.
      - PRESERVING all technical terminology, error
        messages, function names, SQL snippets, code
        identifiers (these are the SEO-load-bearing
        content).
      `project_alias` is the per-lesson primary
      attribution alias (`agent-fleet`, `project-1`,
      etc. — never the real slug). Per LESSONS § "node:
      sqlite's .all() needs `as unknown as T[]`", any
      row narrowing uses the double cast (the lesson
      reader hits the file system, not the DB, so this
      may not apply — but `total_lessons` is bound
      against `project` for the alias map, which does).
      Per LESSONS § "time-pinned tests must NOT derive
      seed timestamps from `new Date()`", every seed
      anchors to the pinned `now`. Test: seed a
      CROSS_LESSONS.md fixture with 5 lessons containing
      project slugs / branch names / paths, assert
      every operator-supplied identifier is replaced
      with an alias; assert technical terms (`node:
      sqlite`, `redactSecrets`, `Record<string,
      SQLOutputValue>`) are PRESERVED verbatim.
- [ ] Per-lesson permalink: `lessonsPublicArchive()`
      exposes a `lesson_slug` per row that is URL-safe
      (lowercase, kebab-case, derived from the lesson
      date + title) AND globally unique across the
      archive. Per LESSONS § "no backticks inside
      template-literal SQL strings" — this is HTML
      rendering, not SQL, but the slug derivation is
      similarly fiddly: assert each slug is a strict
      `^[a-z0-9-]+$` match. Test: seed two lessons
      with the same title but different dates, assert
      both produce distinct slugs; seed a lesson with
      a title containing `:` and `/`, assert the slug
      strips those characters cleanly.
- [ ] `GET /lessons-public` (no auth — public route)
      renders a self-contained single-column HTML page
      listing every lesson, mounted in the SAME outer
      handler family as `/share/<token>`,
      `/receipts/<slug>/<month>`, `/year/<YYYY>`,
      `/pulse` (per ticket 0054), `/calculator`. NO
      `<script>` tag, NO reference to `/api/control/`,
      NO operator project list. Content-Type `text/
      html; charset=utf-8`. Sets `Cache-Control:
      max-age=3600` (1h — the archive grows slowly).
      Sets `<meta name="robots" content="index,
      follow">` AND `<link rel="canonical" href="/
      lessons-public">`. Each lesson section has
      `<h2 id="<lesson-slug>" data-testid="lesson-
      public-<lesson-slug>">`. The page top carries
      `data-testid="lessons-public-header"` with the
      summary line. The page footer carries
      `data-testid="lessons-public-cta"` with the
      install link. Per LESSONS § "defence-in-depth
      secret redaction at the renderer boundary", the
      rendered HTML passes lesson body strings through
      `redactSecrets` BEFORE composition into HTML (the
      anonymiser is a separate pass; redactSecrets is
      the defence-in-depth backstop for any token-
      shape substring that slipped through). Test: hit
      without auth, assert 200 with the header testid;
      assert no operator project slug appears in the
      response; assert the canonical and robots meta
      tags are present.
- [ ] `GET /lessons-public/<lesson-slug>` (no auth —
      public route) renders ONE lesson as the primary
      content. The page sets `<link rel="canonical"
      href="/lessons-public/<lesson-slug>">` AND
      `<meta name="robots" content="index,follow">`.
      Renders the lesson title as `<h1>` (for the SEO
      H1 signal), the lesson date as a `<time>`
      element, the anonymised body as `<p>` blocks.
      Includes a "back to all lessons" link at the
      top. Returns 404 with a friendly HTML page when
      the slug is unknown. Sets `Cache-Control: max-
      age=3600`. Test: hit `/lessons-public/<known-
      slug>`, assert 200 with the lesson content and
      the canonical link; hit `/lessons-public/foo-
      not-real`, assert 404 with a friendly page;
      assert the H1 contains the lesson title verbatim.
- [ ] Anonymisation regression: a static test seeds a
      CROSS_LESSONS.md fixture with operator-leaking
      text patterns (a real-looking project slug like
      `courtiq-prod`, an absolute path `/Users/alice/
      code/courtiq`, a branch name `feat/secret-
      feature-x`, a GitHub PAT pattern `ghp_
      abcdef1234567890`), renders the archive HTML,
      and asserts NONE of the leak patterns appears in
      the body. Per LESSONS § "'no shell-string exec'
      static checks should grep the import, not the
      call site", this static check greps the RENDERED
      HTML STRING — the leak chokepoint. Per LESSONS
      2026-06-10 "redactSecrets on a JSON body shreds
      your KEYS" — this archive is HTML (not JSON), so
      the redactor pass is appropriate over the
      composed body string; assert the lesson STRUCTURE
      (titles, dates, anchors) survives the redaction
      pass. Test: render against the leak fixture,
      assert no `courtiq-prod`, no `/Users/alice`, no
      `feat/secret-feature-x`, no `ghp_` substring
      appears; assert every lesson's `<h2 id="...">`
      still resolves to a present anchor.
- [ ] `GET /api/lessons-public` returns the AC1 shape
      as JSON. NO auth required (same public posture
      as the HTML page). Sets `Cache-Control: max-age=
      3600`. Per LESSONS § "defence-in-depth secret
      redaction at the renderer boundary" AND
      2026-06-10 "redactSecrets on a JSON body shreds
      your KEYS" — scrub `lesson_title` and
      `lesson_body_anonymised` VALUES BEFORE
      `JSON.stringify`, never the body string. Per
      LESSONS § "PRODUCER-VS-SPEC for column-value
      casing" — there is no column casing concern
      here (the source is a markdown file, not a DB
      column), but the same discipline applies to the
      `project_alias` field: assert it's a stable
      stringified alias, never the raw operator slug.
      Test: hit without auth → 200 with the shape;
      assert `project_alias` is `project-N` shape
      (regex `^project-\d+$|^agent-fleet$`); assert no
      field carries the operator's real project slug.
- [ ] Idempotency / caching: the archive helper
      memoises per tuple `(lessons file mtime,
      operator alias map version)`. The file mtime
      catches a fresh `fleet lessons-sync` writing the
      file. The alias map version catches an operator
      adding a new project (rare, but the alias
      mapping must stay consistent). Per LESSONS § "in-
      process dedup sets need an explicit reset hook
      for tests", expose
      `_resetLessonsPublicArchiveCacheForTests()` AND
      `_getLessonsPublicArchiveCacheBuildsForTests()`.
      Per LESSONS 2026-06-05 "break ingest↔server
      cache-invalidation cycles via a globalThis
      slot", the invalidation hook registers on
      `globalThis.__fleet_lessons_public_archive_
      invalidate__`. Test: two calls within TTL assert
      one build via the build counter; touch the
      lessons file, assert the next call rebuilds.
- [ ] Mobile (per 0011): at 375px the archive page is
      one column with comfortable reading width (max
      80ch on desktop, full-width on mobile). At >=
      900px the page renders centred at 80ch max-
      width for legibility. Test: assert the existing
      mobile-portal text-level CSS contract at 375px
      (full-width) and 900px (centred max-width)
      viewport widths.
- [ ] Performance: `lessonsPublicArchive()` against a
      150-lesson fixture completes in under 100ms
      (cache miss) and under 5ms (cache hit). The
      rendered HTML page size is under 200KB
      uncompressed (~50KB gzipped) — small enough to
      first-paint on a cellular connection. Per
      LESSONS § "in-process startServer() tests need
      an empty-roots config + run-row seeds", server-
      boot tests plant a tmp `fleet-control.config.
      json` in cwd and restore on cleanup. Per
      LESSONS § "julianday() drifts ~10us per
      timestamp" — N/A here (no SQL date arithmetic),
      but the principle generalises: avoid float-day
      intermediates anywhere. Test: seed the fixture,
      time both paths, assert thresholds; render the
      page, assert byte size; (skip perf assertions
      when `process.env.PERF !== "1"`).
- [ ] Cross-link from existing surfaces: the
      authenticated `/lessons` page (per 0036) grows
      ONE footer line "this archive is also available
      publicly at /lessons-public — anyone with the
      link can read the anonymised lessons" with
      `data-testid="lessons-public-cross-link"`. This
      is an additive HTML change, NOT a JSON-shape
      break. Test: hit the authenticated `/lessons`,
      assert the cross-link testid is present with
      href `/lessons-public`.
- [ ] No new runtime deps. `tsc --noEmit` clean. No
      shell-string composition. The HTML pages are
      mounted as NET-NEW routes (no JSON-shape break
      to any existing `/api/...` route). The
      additive footer line on `/lessons` is HTML-
      only — no JSON field changes. No schema
      migration — composes the existing CROSS_LESSONS.
      md file via the existing 0036 reader and the
      existing `project` table for the alias map. Per
      LESSONS § "no backticks inside template-
      literal SQL strings", identifiers stay plain
      words.

## Out of scope

- A sitemap.xml of every lesson permalink. Search
  engines will discover the permalinks via the
  archive page's `<h2 id>` links; a sitemap is a
  follow-up optimisation.
- An RSS/Atom feed of newly-published lessons. The
  archive URL is the discovery shape; feed
  subscriptions are a follow-up.
- An opt-OUT surface for the operator who wants their
  lessons NOT published. v1 publishes all lessons by
  default since the anonymisation is already strong;
  opt-out is a follow-up if asked.
- A "rate this lesson" reaction surface. The page is
  read-only by design; ratings invite spam and
  analytics fleet-control doesn't collect.
- An LLM-authored "lesson summary" sentence above
  each lesson. The lesson body is the SEO content;
  LLM summarisation invites cost and hallucination.
- Per-lesson view counts or popularity sorting.
  Analytics violate the no-phone-home posture; the
  lesson order is chronological (most-recent first)
  by design.
- An "embed this lesson" iframe widget. The
  permalink URL is the embed shape (Discord, Slack,
  GitHub markdown all unfurl public URLs).
- A "post a lesson" inbound submission form. The
  archive is downstream of the operator's own
  CROSS_LESSONS.md; external submissions are a
  governance problem fleet-control is not equipped
  to solve.
- Multi-fleet (cross-operator) lesson aggregation.
  Single-fleet by design — each fleet-control
  install publishes its OWN anonymised lessons; a
  public meta-archive is a follow-up that requires
  cross-operator coordination fleet-control does
  not have.

## Engineering notes

- `src/lessons.ts` — new `lessonsPublicArchive(opts)`
  helper next to the existing 0036 portal helper.
  PRODUCER-VS-SPEC NOTE: grep `src/lessons.ts` for
  the existing parsed-lesson shape — the new helper
  composes that shape with a new anonymisation pass.
  The anonymisation pass uses the same alias logic
  as `src/snapshot.ts:anonymize()` (per 0013); reuse
  the helper if the shape matches. Per LESSONS §
  "node:sqlite's .all() needs `as unknown as T[]`",
  the alias-map SELECT from `project` uses the
  double cast.
- `src/server.ts` — three new handlers near the
  existing `/lessons` / `/share` / `/receipts` /
  `/calculator` / `/pulse` (per 0054) routes:
  `GET /lessons-public` (HTML, public, no auth),
  `GET /lessons-public/<lesson-slug>` (HTML, public,
  no auth), `GET /api/lessons-public` (JSON, public,
  no auth). Per LESSONS 2026-06-05 "break ingest↔
  server cache-invalidation cycles via a globalThis
  slot", the cache invalidation function MUST be
  registered on `globalThis.__fleet_lessons_public_
  archive_invalidate__` from `src/server.ts`. The
  invalidation trigger is the file mtime change —
  there is no producer module to import from; the
  cache simply checks mtime on each call (per AC7).
- `src/server.ts` — additive footer line on the
  existing `/lessons` (per 0036) HTML render path.
  PRODUCER-VS-SPEC NOTE: grep `src/server.ts` for
  the `/lessons` handler before placing the line.
  The line is HTML-only; no JSON field changes.
- `tests/lessons-public-archive.test.ts` (new) —
  one `test(...)` per AC checkbox. Per LESSONS §
  "time-pinned tests must NOT derive seed
  timestamps from `new Date()`", every seed anchors
  to the test's pinned `now`. Per LESSONS § "in-
  process startServer() tests need an empty-roots
  config + run-row seeds", server-boot tests plant
  a tmp `fleet-control.config.json` in cwd and
  restore on cleanup. Per LESSONS § "anomaly tests
  need σ > 0 in the fixture" — N/A (no numeric
  thresholds), but the principle generalises: the
  anonymisation fixture spreads operator-leak
  patterns across the lesson bodies so the
  regression test is geometrically meaningful. Per
  LESSONS § "expose a build counter for cache-hit
  tests, not a fetcher swap", AC7 uses the build
  counter. Per LESSONS § "'no shell-string exec'
  static checks should grep the import, not the
  call site", AC5's static leak check greps the
  RENDERED RESPONSE STRING.
- `web/style.css` — one selector group for the
  public lesson archive (centred max-width 80ch,
  legible body type, reuses receipts/year-in-
  review structural CSS). Reuse existing CSS
  variables for color and font; do NOT add new
  ones.
- Schema migration: NO new tables. Composes
  existing `project` table for the alias map and
  the CROSS_LESSONS.md file via the existing 0036
  reader.
- No new runtime deps. Pairs with 0036 (lessons
  portal — the authenticated equivalent), 0013
  (shareable snapshot — same anonymisation
  discipline), 0041 (receipts — same public-route
  posture), 0051 (calculator — sibling public
  acquisition surface), 0054 (pulse — sibling
  public acquisition surface), 0055 (lesson of
  the day — internal surface that surfaces
  selected lessons; this ticket exposes ALL
  lessons publicly).

## Implementation log

- 2026-06-12 (implementation-dev): branch `feat/0057-public-lesson-archive`
  off origin/main, status flipped to `in-progress`. README index row
  reconciled from P1 → P2 to match this file's frontmatter (the validator
  checks status drift; priority drift is doc-only but reconciled in the
  same PR so the index doesn't lie). Plan: extend `src/lessons.ts` with
  `lessonsPublicArchive(opts)` + slug derivation + anonymiser; mount
  three new public routes in `src/server.ts` (`GET /lessons-public`,
  `GET /lessons-public/<slug>`, `GET /api/lessons-public`) BEFORE the
  `/api/` auth gate so they share the `/pulse` no-auth posture; expose
  `_resetLessonsPublicArchiveCacheForTests` +
  `_getLessonsPublicArchiveCacheBuildsForTests` +
  `_renderLessonsPublicForTests` seams per the 2026-06-11 lessons; new
  CSS group in `web/style.css` (centred max-width 80ch) reusing existing
  variables; one footer line on the authenticated `/lessons` SPA route
  for AC9 cross-link. NO new schema. NO new runtime dep.
