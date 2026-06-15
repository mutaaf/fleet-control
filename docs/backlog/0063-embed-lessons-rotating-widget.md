---
id: 0063
title: Embeddable lesson-of-the-day widget - paste-one-line snippet that rotates a cross-fleet operational lesson into any blog or README so every reader sees a real fleet insight
status: shipped
priority: P2
area: portal
created: 2026-06-15
owner: gtm-innovation
---

## User story

As a fleet operator who maintains a personal engineering blog AND a GitHub
profile README, who already pastes the 0060 pulse widget into a sidebar
but wants a SECOND embeddable widget that rotates a different operational
LESSON each day (not a stat - a one-paragraph SQL-trap / token-shape /
ingest-cycle insight pulled from the cross-fleet LESSONS.md), I want a
single `/embed/lessons.html?slug=fleet` HTML snippet plus an SVG fallback
that drops a live lesson card into any HTML surface, so that every reader
of my personal blog sees a real operational insight from the fleet -
turning the cross-fleet lessons file (which today only fleet-control
operators read) into a public-facing trust artifact.

## Why now (four lenses)

### Product Owner

0060 (pulse widget) just shipped the FIRST embeddable artifact - a 300x180
iframe + SVG drop-in showing this week's three pulse stats. Its
out-of-scope section explicitly named this v2 follow-up: "A `/embed/
lessons.html` widget that embeds the lesson-of-the-day. v1 ships the
pulse widget only; lesson embed is a follow-up if operator feedback
demands it." The signal: the same operator who shares /pulse on social
ALSO shares lessons (per 0055 lesson-of-the-day card on the home page,
which the operator already screenshots) - the lesson surface is the
HIGHER-TRUST artifact because a stat is a number but a lesson is a hard-
earned narrative.

The smallest meaningful unit of value: ONE new embed route
(`/embed/lessons.html?slug=fleet`) plus an SVG fallback
(`/embed/lessons.svg?slug=fleet`) rendering a 320x200px card with:
- The rotating lesson's TITLE (one line, e.g. "no backticks inside
  template-literal SQL strings")
- A two-line excerpt of the lesson's BODY (anonymised via the existing
  0057 anonymisation pass - operator slugs and `/Users/` paths
  collapsed to placeholders)
- The lesson's CADENCE date (the `## YYYY-MM-DD` heading)
- A footer "powered by fleet-control - install yours" CTA

The rotation cadence matches the existing 0055 lesson-of-the-day helper
(one lesson per UTC day, deterministically picked via the lesson's slug
hash modulo the lessons count). Per LESSONS 2026-06-13 "function-import
cycles aren't always cache-invalidation; sometimes the cheapest fix is
a 6-line inline copy of the helper" - the embed module reaches the
lesson selector via the existing exported helper in `src/lessons.ts`;
if that helper would create a cycle with the embed module, the cheapest
fix is an inline private copy of the 6-line selection helper (do NOT
reach for the globalThis-slot pattern; that pattern is for stateful
cache invalidation, NOT pure function dependency).

The embed posture mirrors 0060 exactly:
1. `/embed/lessons.html` - self-contained HTML, no `<script>`,
   320x200px, sets `X-Frame-Options: SAMEORIGIN` by default,
   `embedOrigins` config widens the frame-ancestors per 0060.
2. `/embed/lessons.svg` - hand-rolled SVG fallback for surfaces like
   GitHub READMEs that strip iframes.

The operator's `/share` page (per 0060) grows a SECOND embed-snippets
section ("embed today's lesson") next to the pulse snippets, with the
same three copy-to-clipboard shapes (iframe / img / markdown).

PRODUCER-VS-SPEC NOTE: per LESSONS 2026-06-05 "groomer prose can
disagree with the schema" the implementing dev MUST grep
`src/lessons.ts` for the existing `lessonOfTheDay()` helper output
shape (per 0055) AND the existing `anonymiseLessonBody()` helper (per
0057) BEFORE composing the embed renderer. The lesson selector's
output is `{ slug, date_iso, title, body_excerpt, ... }` - the
schema-named field is the contract. Per LESSONS 2026-06-10
"PRODUCER-VS-SPEC for column-value casing" - there is no `pr.state`
or `outcome` literal in this surface (the lessons table per 0057's
schema does NOT depend on those literals); but the lesson body
strings pass through `anonymiseLessonBody()` which IS the producer
helper for anonymisation.

### Stakeholder

Widens the moat on the LESSON-SHAPED VIRAL DISTRIBUTION axis where no
other tool can invest. 0060 invests in STAT-shaped distribution; the
lesson widget invests in NARRATIVE-shaped distribution - a structurally
different acquisition funnel. A reader who sees the pulse widget thinks
"this person is shipping stuff"; a reader who sees the lesson widget
thinks "this person is operating a system carefully enough to extract
generalisable insights" - the second impression converts a higher-quality
prospect.

Per the cross-fleet courtiq lesson "the artifact that LEAVES THE OPERATOR
LOOKING SMARTER than they were before installing the tool is the
artifact that converts the highest-quality prospects" (CROSS_LESSONS
section courtiq Entries 2026-05-21 family on share-flow), the lesson
embed is exactly that artifact - the operator hosts a widget on their
blog and gets the credit for the insight (it's their fleet's lesson),
while the footer attribution converts the curious reader. fleet-control
is the only tool that can author this: the LESSONS.md file is a real
operational artifact (not marketing copy), and the rotation gesture
makes it feel like a daily-changing newsfeed without any LLM call.

The structural moat: a SaaS dashboard could publish a "tip of the day"
but it would be marketing-authored, not real-operator-authored. The
fleet-control lesson widget rotates entries written by the actual
loop's review agents - the moat is the LIVE PROVENANCE.

The screenshot worth sharing: a personal blog sidebar carrying a
lesson card titled "the `pr` table has no surrogate `id`; proxy
'latest landed' via (MAX(fetched_at), COUNT(*))" - a verdict only
fleet-control can author because no SaaS has this exact operational
memory.

Pairs with 0057 (public lesson archive - this widget DEEP LINKS to
the same anonymised surface), 0060 (pulse widget - sibling embed
artifact), 0055 (lesson-of-the-day card - the home-page sibling
that this widget mirrors for external surfaces), 0013 (share page -
the operator's home base for finding the snippet to paste).

### User (operator on the portal AND third-party readers seeing the
embed)

Two distinct users:

1. The operator (one-time setup): visits `/share`, sees a new "embed
   today's lesson" section below the existing "embed your fleet
   pulse" section, copies the iframe one-liner with one tap. The
   section has `data-testid="embed-lessons-section"` (per LESSONS
   2026-06-12 "greedy `[^>]+id=` regex" anchor). At 375px the
   snippets are single-column with three stacked copy buttons.

2. The third-party reader (the operator's audience): sees the
   embedded card with TODAY's lesson title and body excerpt. The
   excerpt is anonymised (per 0057's `anonymiseLessonBody()`) so
   operator slugs, `/Users/<name>/` paths, agent branch names all
   collapse to placeholders. The footer "powered by fleet-control -
   install yours" links to `/lessons-public/<slug>` (the existing
   0057 archive) so the curious reader lands on a deeper artifact,
   NOT on a generic install page. NO `<script>` runs in the iframe.

Honest empty state: when the LESSONS.md file is empty or has fewer
than 3 lessons (genuinely warming-up fleet), the embed renders
"fleet is still learning - no lessons yet" inside the same 320x200
frame. Per CROSS_LESSONS section courtiq share-flow authenticity
2026-05-25 family, the embed NEVER fabricates an authoritative-
looking lesson when there's no real data.

The rotation is DETERMINISTIC: the same lesson appears on the same
UTC day for every reader of every embed. The operator who pastes
the snippet on Monday and the reader who visits the operator's
blog on Tuesday see DIFFERENT lessons (because the rotation
advances each UTC day), but two different readers visiting on the
same UTC day see the SAME lesson.

Per LESSONS 2026-06-11 "startServer() tests that mutate `fleet-
control.config.json` race against parallel test files; expose a
renderer-direct seam for branch tests" - the rotation / empty-
state / embed-origin branches are driven through a
`_renderEmbedLessonsHtmlForTests(payload, opts?)` seam, NOT a cwd
config mutation.

### Growth

The "show me" moment is a friend visiting the operator's blog,
seeing a sidebar card with a real SQL-trap lesson, and following the
footer link to `/lessons-public/<slug>` where they read the full
anonymised lesson PLUS the fleet-control README link. Per the cross-
fleet courtiq lesson "the artifact that lives on the audience's
surface, not yours, is the cheapest distribution shape" (CROSS_LESSONS
section courtiq Entries 2026-05-21 family on share-flow), the lesson
widget is exactly that shape applied to the highest-trust artifact
fleet-control owns (the operational memory file).

A subtle but important moat property: the widget is RENDERED FRESH on
every request, so the lesson rotates without the embedder taking any
action. A blog sidebar that an operator pasted six months ago is STILL
serving a different lesson today than it served six months ago. The
embedder's surface BREATHES at the cadence of the rotating helper -
zero maintenance, zero re-paste.

The lesson surface is also the right shape for a CONFIRMING signal -
the reader who already follows the operator on Twitter and is
considering installing fleet-control sees the widget, the lesson is
genuinely interesting, the click-through is high-intent. Per the cross-
fleet courtiq lesson "high-trust impressions convert at 10x the rate of
high-traffic impressions" (CROSS_LESSONS section courtiq Entries 2026-
05-21 family on share-flow), the lesson widget is the high-trust
counterpart to the pulse widget's high-traffic.

Pairs with 0057 (lesson archive - the click-through landing surface),
0060 (pulse widget - sibling stat-shaped embed), 0055 (home-page
lesson-of-the-day card - the operator's daily prompt that becomes a
public artifact), 0058 (failure-mode landing pages - SEO-shape
sibling).

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: per
LESSONS 2026-06-05 "groomer prose can disagree with the schema" the
implementing dev MUST grep `src/lessons.ts` for the existing
`lessonOfTheDay()` helper output shape (per 0055) AND for the existing
`anonymiseLessonBody()` helper (per 0057) BEFORE composing the embed
renderer. Per LESSONS 2026-06-13 "function-import cycles aren't always
cache-invalidation; sometimes the cheapest fix is a 6-line inline copy
of the helper" - if the embed module would create a cycle with
`src/lessons.ts` OR `src/views.ts`, the FIX is an inline private copy
of the 6-line selection helper, NOT a globalThis slot (that pattern is
for stateful cache invalidation only).

- [ ] `GET /embed/lessons.html` (no auth - public route, mounted BEFORE
      the `path.startsWith("/api/")` auth gate per the 0060 embed
      posture) renders a self-contained 320x200px HTML page. NO
      `<script>` tag. NO operator project list. Content-Type
      `text/html; charset=utf-8`. Cache-Control `max-age=300` (5min;
      same cadence as 0060 pulse embed). Sets `X-Frame-Options:
      SAMEORIGIN` by default; widens via the `embedOrigins` config
      field already added by 0060. Sets `Content-Security-Policy:
      frame-ancestors 'self'`. Renders the TODAY's lesson's title,
      a two-line body excerpt, the lesson's date, and a footer CTA -
      each carrying `data-testid="embed-lessons-title"`,
      `embed-lessons-excerpt`, `embed-lessons-date`,
      `embed-lessons-cta`. Per LESSONS 2026-06-12 "greedy `[^>]+id=`
      regex" - tests anchor on the testid attribute. Test: hit
      without auth -> 200, four testids present, no project slug in
      response body, X-Frame-Options header present.

- [ ] `GET /embed/lessons.svg` (no auth) renders the same lesson as a
      hand-rolled SVG image (per the 0015 + 0060 precedent). 320x200px
      viewBox, the title as a `<text>` element, the excerpt as two
      `<text>` lines, the date at the bottom, the footer link as a
      clickable `<a>` inside the SVG. Content-Type `image/svg+xml`.
      Cache-Control `max-age=300`. Test: hit without auth -> 200,
      content-type svg, the lesson title substring appears in the
      response body, no operator slug appears.

- [ ] Rotation determinism: the helper picks the lesson via a stable
      function of the UTC date (matching the 0055 `lessonOfTheDay()`
      convention). Test: drive the renderer with three anchor dates
      (2026-06-15, 2026-06-16, 2026-06-22 - one week later); assert
      the same anchor produces the same lesson title across multiple
      calls; assert two consecutive days produce DIFFERENT lessons;
      assert the rotation cycles back when the cycle length exceeds
      the lessons count.

- [ ] Anonymisation pass: a fixture seeds a LESSONS.md with operator-
      identifying strings (`/Users/jane/code/`, `mutaaf-secret-tool`,
      a real PR URL `https://github.com/mutaaf/internal/pull/123`).
      Renders the embed; asserts NONE of those strings appears in the
      response body. The anonymisation reuses the existing 0057
      `anonymiseLessonBody()` per LESSONS 2026-06-13 - if the embed
      module would need to import from `src/lessons.ts` AND
      `src/lessons.ts` already imports from `src/views.ts` which the
      embed module would import, the inline 6-line copy is the
      cheapest fix. Per LESSONS 2026-06-10 "redactSecrets on a JSON
      body shreds your KEYS" - since this is HTML/SVG (not JSON),
      VALUE-side redaction (sanitise the lesson body string BEFORE
      it reaches the HTML/SVG template, NOT body-string redaction
      over the rendered output) is the appropriate posture. Test:
      assert the rendered body contains the placeholders (`/Users/
      <user>/`, `<project>`, `<pr-url>`) and NONE of the seeded
      identifiers.

- [ ] Honest empty state: when the LESSONS.md file has fewer than
      3 lessons total OR the lesson selector returns null, the
      embed renders "fleet is still learning - no lessons yet"
      inside the same 320x200 frame. Per CROSS_LESSONS section
      courtiq share-flow authenticity 2026-05-25 family, the embed
      NEVER fabricates an authoritative-looking lesson when there's
      no real data. Test: seed an empty fixture; assert the
      sentence appears in both HTML and SVG renders.

- [ ] Embed-origin allowlist via shared config: the new
      `/embed/lessons.html` route honours the EXISTING
      `embedOrigins` config field (added by 0060) - the same
      operator config that widens the pulse embed also widens
      the lessons embed. Per LESSONS 2026-06-11 "startServer()
      tests that mutate `fleet-control.config.json` race against
      parallel test files; expose a renderer-direct seam for
      branch tests" - the embed-origin branch is exercised via
      a renderer-direct seam, NOT a cwd config mutation. Test:
      drive the renderer with two embedOrigins configs (empty,
      and `["https://operator.dev"]`); assert the response
      headers include the correct frame-ancestors values per
      config.

- [ ] Portal embed-snippets section on `/share`: a new section
      below the existing "embed your fleet pulse" section (per
      0060) titled "embed today's lesson", rendering THREE
      copy-to-clipboard snippets (iframe HTML / img HTML /
      Markdown). Each snippet has `data-testid="embed-lessons-
      snippet-<kind>"` where kind is `iframe` / `img` /
      `markdown`. Each snippet has a copy-to-clipboard button
      with `data-testid="embed-lessons-copy-<kind>"`. Per
      LESSONS 2026-06-12 - the testids carry distinctive
      prefixes so any test scraping the rendered HTML anchors
      on the data-testid, NOT a greedy `id=` match. Test: hit
      `/share` with a valid token, assert the three snippet
      testids are present; assert each carries the same
      `<host>` substring derived from the request.

- [ ] Idempotency / caching: the embed renderer memoises the
      lesson payload per tuple `(date_iso, lessons_file_mtime,
      lessons_file_size)`. The lessons file mtime + size is
      the natural invalidation signal because LESSONS.md is a
      static markdown file the operator edits (NOT a SQL table
      with a fetched_at column). Per LESSONS section "in-
      process dedup sets need an explicit reset hook for
      tests", export `_resetEmbedLessonsCacheForTests()` AND
      `_getEmbedLessonsCacheBuildsForTests()`. Per LESSONS
      section "expose a build counter for cache-hit tests" -
      test asserts the build counter goes up 1 then 0 across
      two same-tuple calls; the counter goes up again when
      the fixture LESSONS.md mtime changes. Per LESSONS 2026-
      06-05 "break ingest<->server cache-invalidation cycles
      via a globalThis slot" - no globalThis slot needed here
      because the invalidation signal (file mtime) is read
      lazily on each request from the OS, not pushed from a
      producer; the cycle pattern only applies to producer-
      pushed invalidation.

- [ ] Time-pinned tests: every test fixture seeding lessons or
      rotation dates derives its seed timestamps from a pinned
      `now`, never from `new Date()`. Per LESSONS 2026-05-29
      "time-pinned tests must NOT derive seed timestamps from
      `new Date()`" - the rotation depends on the UTC date; a
      fixture authored on 2026-06-15 and run on 2026-06-18
      MUST still pass because the seeds derive from the
      anchor, not the wall clock.

- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-
      string composition. The HTML and SVG embeds are NET-
      NEW routes (no JSON-shape break to any existing
      `/api/...` route). The `/share` snippet section is
      additive HTML. The `embedOrigins` config field is
      REUSED from 0060 (no new field). NO schema migration -
      composes existing LESSONS.md file + the existing 0055
      / 0057 helpers. Per LESSONS section "no backticks
      inside template-literal SQL/HTML/SVG template strings" -
      identifiers stay plain words inside any backtick
      template. Per LESSONS 2026-06-11 "character-window
      source greps leak into sibling helpers" - the new
      helper's comment block uses PLAIN PROSE (no backticks)
      for any identifier that a 0052-family slice-and-grep
      test might capture.

## Out of scope

- An `/embed/badge.html` widget wrapping the existing 0015 SVG
  badge in an iframe. The badge is already an SVG and works in
  any context an iframe wouldn't; wrapping is duplicative.
- A `/embed/failures.html` widget rotating cross-fleet failure-
  mode signatures (per 0058). The failure surface is SEO-shape,
  not embed-shape; a v2 follow-up if operator feedback demands.
- An embed analytics surface (impressions, click-throughs).
  Analytics violate the no-phone-home posture.
- A "customise your embed" surface (operator picks colors,
  picks which lessons rotate). v1 is fixed-layout for
  distribution consistency; customisation is a follow-up.
- A per-operator lesson curation interface (operator marks
  some lessons as "embed-eligible"). v1 rotates ALL lessons
  with the existing anonymisation pass; curation is a
  follow-up if a leak slips through.
- An RSS-shaped variant. The HTML + SVG covers the embed
  surface; RSS is a different consumption shape (feed
  readers).
- A multi-lesson carousel (three lessons rotating inline).
  v1 is single-lesson; carousel violates the no-script
  constraint.

## Engineering notes

- `src/server.ts` - two new public route handlers (`GET
  /embed/lessons.html`, `GET /embed/lessons.svg`) mounted
  BEFORE the `path.startsWith("/api/")` auth gate, alongside
  the existing 0060 `/embed/pulse.*` routes. Each route
  shares the 0060 cache-control / x-frame-options / CSP
  posture; the only difference is the renderer content.
- `src/embed.ts` (existing module from 0060) - extended
  with two new exported renderers
  (`renderEmbedLessonsHtml(payload, opts)`,
  `renderEmbedLessonsSvg(payload)`) plus the cache layer
  (memoised on `(date_iso, lessons_file_mtime,
  lessons_file_size)`, with the build-counter and reset
  seams). The SVG is hand-rolled per the 0015 + 0060
  precedent (string concatenation, no template engine).
  Per LESSONS 2026-06-13 "function-import cycles aren't
  always cache-invalidation; sometimes the cheapest fix is
  a 6-line inline copy of the helper" - if the embed
  module would need to import a helper from `src/lessons.ts`
  AND `src/lessons.ts` already imports from `src/views.ts`
  which `src/embed.ts` might import, the cheapest fix is
  an inline private copy of the 6-line selection helper.
- `src/lessons.ts` (existing per 0055 / 0057) - re-uses
  the existing `lessonOfTheDay()` helper if the dependency
  shape is acyclic; otherwise the embed module carries a
  private inline copy per LESSONS 2026-06-13.
  PRODUCER-VS-SPEC NOTE: grep the existing helper for the
  output field shape (`title`, `date_iso`, `body_excerpt`,
  `slug`) BEFORE composing the embed renderer.
- `web/app.js` - the existing `/share` page (per 0060)
  grows a second snippets section below the pulse
  snippets. The new section's testids carry the
  `embed-lessons-` prefix (per LESSONS 2026-06-12
  anchor).
- `web/style.css` - no new selectors; reuse the existing
  `.embed-snippet` class from 0060 (added there for the
  pulse snippets). The embed page's CSS is INLINED in a
  `<style>` tag inside the rendered HTML so the iframe
  needs zero extra HTTP requests.
- `tests/embed-lessons.test.ts` (new) - one `test(...)`
  per AC checkbox. Per LESSONS section "time-pinned
  tests must NOT derive seed timestamps from `new
  Date()`", every seed anchors to the pinned `now`. Per
  LESSONS 2026-06-11 "startServer() tests that mutate
  `fleet-control.config.json` race against parallel test
  files; expose a renderer-direct seam" - rotation /
  anonymisation / empty-state / embed-origin branches
  drive the renderer directly via the
  `_render*ForTests` seams, NOT via cwd config mutation.
- Schema migration: NO. The LESSONS.md file is the data
  source; no new tables.
- No new runtime deps. Lean on `node:sqlite`, `node:http`,
  `fs.statSync` (for the mtime+size invalidation read),
  the standard library. Pairs with 0060 (sibling embed
  artifact - same headers, same /share section, same
  config field), 0055 (lesson-of-the-day card - the
  home-page sibling), 0057 (public lesson archive - the
  click-through landing surface from the embed footer
  CTA), 0013 (share page host).

## Implementation log

- 2026-06-15 — implementation-dev: branch `feat/0063-embed-lessons-rotating-widget`
  cut from main. Extending `src/embed.ts` with two new renderers
  (`renderEmbedLessonsHtml`, `renderEmbedLessonsSvg`) plus a private inline
  `anonymiseEmbedExcerpt` per LESSONS 2026-06-13 (avoid the function-import
  cycle with `src/lessons.ts` which already imports from `src/views.ts`).
  Wiring two new public routes (`/embed/lessons.html`, `/embed/lessons.svg`)
  in `src/server.ts` BEFORE the `/api/` auth gate, mirroring the 0060
  posture. Cache memoised on `(date_iso, lessons_file_mtime,
  lessons_file_size)` — file-based invalidation, no globalThis slot needed
  (the signal is OS-side, not producer-pushed). New `/share` snippet
  section appended below the existing 0060 pulse snippets.
- 2026-06-15 — PR #150 merged green on both gating checks (typecheck +
  validate). 24 new tests in `tests/embed-lessons.test.ts` all pass.
  Novel lesson appended to `docs/LESSONS.md`: a static grep that uses
  `SERVER_TS.indexOf('path.startsWith("/api/")')` to assert
  "route mounted BEFORE the /api/ auth gate" falsely succeeds when a
  sibling helper's COMMENT block contains that string verbatim —
  anchor on the actual `if (path.startsWith(...))` statement instead.
