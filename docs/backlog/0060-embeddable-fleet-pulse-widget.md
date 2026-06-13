---
id: 0060
title: Embeddable HTML pulse widget - paste-one-line snippet that drops a live fleet pulse into any personal blog or README so every reader becomes a fleet-control prospect
status: groomed
priority: P2
area: portal
created: 2026-06-13
owner: gtm-innovation
---

## User story

As a fleet operator who keeps a personal blog AND a personal README on
GitHub, who already shares /receipts (0041) and /pulse (0054) URLs by
hand on Twitter when they remember to, I want a single
`/embed/pulse.html?slug=fleet` HTML snippet plus a copy-pastable one-line
`<iframe>` embed code on the operator's portal that drops a live, mobile-
sized, zero-script fleet-pulse card into ANY page - my personal blog
sidebar, my GitHub profile README via the `img.shields.io`-style image
fallback, my Linkedin "featured" post via the iframe - so that every
reader of those personal surfaces sees a live fleet number with a
fleet-control attribution link, and the operator's existing personal
audience becomes the moat-distribution surface no other tool can
author.

## Why now (four lenses)

### Product Owner

0015 (status badge SVG) gives the operator a per-project
`<img src="/badge/<slug>.svg">` snippet - good for a README's quick
visual cue, but ONE line of data only ("ship 3h", "$3.21", or "ok").
0054 (public weekly pulse) gives a full /pulse URL the operator can
link to - good for a blog post or tweet, but the reader has to CLICK
to see anything.

The gap: there's no FLEET-LEVEL visual artifact the operator can
embed INLINE that auto-updates without script. A blog post linking
to /pulse goes stale the moment the reader doesn't click through; a
README badge shows one metric but not the narrative. The smallest
meaningful unit of value: ONE embeddable `<iframe>` snippet (plus a
`<img>` fallback for surfaces like the GitHub profile README that
strip iframes) that renders the same three-stat block as 0054 /pulse
- merged PRs this week, $ spent, $ per merged PR - sized for a blog
sidebar (300x180px, fits a typical right-column widget area).

The embed posture is two-tier:
1. `/embed/pulse.html?slug=fleet` - a self-contained HTML page that
   the iframe loads. Server-rendered, zero `<script>`, fits 300x180
   px exactly, sets `X-Frame-Options: SAMEORIGIN` BY DEFAULT and
   allows whitelisted embed_origins via a new `fleet-control.config.
   json` field. Per LESSONS section "defence-in-depth secret
   redaction at the renderer boundary", the rendered HTML passes
   through redactSecrets at the renderer boundary.
2. `/embed/pulse.svg?slug=fleet` - an SVG image fallback the
   operator can embed via `<img>` on surfaces like GitHub profile
   READMEs that strip iframes. Composes the same three stats as an
   SVG-rendered card (hand-rolled SVG string per the 0015 badge
   precedent - NO template engine, NO new dep).

The operator's portal grows ONE new section on the existing
`/share` page (per 0013) titled "embed your fleet pulse" that
renders three copy-to-clipboard snippets: the iframe code, the
img code, and a plain Markdown image link for README pastes. The
snippets are derived from the operator's own host/slug.

PRODUCER-VS-SPEC NOTE: per LESSONS 2026-06-05 "groomer prose can
disagree with the schema" - this ticket composes existing
`fleetWeeklyPulse` data (per 0054 `src/views.ts:~6922`) with no
new column. Grep `src/views.ts` for the helper's output shape
before writing the embed renderer. Per LESSONS 2026-06-12
"greedy `[^>]+id=` regex over a `<h2 id="..." data-testid="...">"
- any HTML attribute grep in the tests anchors on the testid
attribute, never a greedy `id=` regex.

### Stakeholder

Widens the moat on the VIRAL-DISTRIBUTION axis where no existing
surface invests. 0054 /pulse is the operator's BOOKMARK shape;
0041 /receipts is the operator's BLOG-LINK shape; 0015 badge is
the per-project README shape. None of them are EMBED-INLINE
artifacts the operator can paste into ANY HTML surface they
control.

Per the cross-fleet courtiq lesson "the artifact that lives on
the audience's surface, not yours, is the cheapest distribution
shape" (CROSS_LESSONS section courtiq Entries 2026-05-21 family
on share-flow - the relocation-CTA generalisation), the embed
widget is exactly that artifact applied to fleet-control's most
narrative public number. Every paste of the snippet is a
permanent fleet-control impression on a surface the operator's
audience already trusts (their own blog/README/profile). Per the
courtiq same family, the embed surface is structurally
impossible for any tool that doesn't own both the live ingest
AND the cross-origin rendering pipeline.

The screenshot worth sharing: an operator's personal blog
sidebar carrying a live fleet-pulse card with the date showing
THIS week - a verdict only fleet-control can author because no
SaaS dashboard exposes a public embeddable artifact without
requiring the reader to log in.

Pairs with 0015 (badge SVG - this widget is the FLEET-level
equivalent, three stats wide), 0054 (pulse URL - same data
source, different consumption surface), 0041 (receipts -
sibling share artifact, lower cadence).

### User (operator on the portal, AND third-party readers
visiting the embed)

Two distinct users:

1. The operator (one-time setup): visits the `/share` page,
   sees a new "embed your fleet pulse" section, copies the
   iframe one-liner with one tap, pastes into their blog/
   README/Linkedin. At 375px the snippet section is single-
   column with three copy-to-clipboard buttons stacked. Each
   button has `data-testid="embed-copy-<kind>"` for testable
   reach.

2. The third-party reader (the operator's audience): sees
   the embedded card on whatever surface the operator
   pasted it onto. The card renders the same three stats as
   /pulse (merged PRs / spent / $/PR), the week-of date, and
   a footer link "powered by fleet-control - install yours"
   that opens the fleet-control GitHub URL in a new tab. The
   card is mobile-sized (300x180px) so it fits a typical
   sidebar without breaking a parent blog's layout. NO
   JavaScript runs inside the iframe (per AGENTS.md zero-
   dep, AND per the cross-origin security posture - a script-
   carrying iframe is a phishing vector). The reader sees
   the SAME content whether they open the operator's blog
   in Safari, Brave, or a phone browser on a flaky
   connection.

Honest empty state: when the fleet has shipped 0 PRs this
week, the embed renders "fleet is quiet this week - nothing
shipped" (mirrors 0054 /pulse's honest empty-state per
CROSS_LESSONS section courtiq share-flow authenticity 2026-
05-25 family). The embed never lies up.

### Growth

The "show me" moment is a permanent fleet-control impression
on someone else's surface. Per the cross-fleet courtiq lesson
"the prospect's first impression of your tool is most likely
to be the impression LEFT BY A CURRENT USER, not by you"
(CROSS_LESSONS section courtiq Entries 2026-05-21 family on
share-flow), the embed widget is exactly that surface applied
to fleet-control's most narrative shape. Every reader of the
operator's blog is a high-intent prospect (they already trust
the operator's taste in tools) and every embed paste is
permanent (unlike a tweet which scrolls away).

Pairs with 0015 (badge - the project-level viral surface),
0051 (calculator - the click-through landing page from the
embed footer link), 0057 (lesson archive - sibling SEO
acquisition surface).

A subtle but important moat property: the embed page is
RENDERED FRESH on every request (no `<script>` polling, no
cache busting on the embedder's side) so a reader visiting
the same operator's blog two weeks apart sees different
numbers - the embed BREATHES even though the embedding page
doesn't change. Same liveness shape as 0054 /pulse, applied
to a different consumption surface.

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: per
LESSONS 2026-06-05 "groomer prose can disagree with the schema; the
schema wins" the implementing dev MUST grep `src/views.ts` for
`fleetWeeklyPulse()` (per 0054 line ~6922) for the data shape this
embed renders. Per LESSONS 2026-06-10 "PRODUCER-VS-SPEC for column-
value casing" - the underlying `pr.state = 'MERGED'` literal is the
existing convention; no new column casing risk. Per LESSONS 2026-06-07
"the pr table has no surrogate id" - the embed cache invalidation
tuple uses `(MAX(pr.fetched_at), COUNT(*))` over `pr`, mirroring 0040 /
0044 patterns.

- [ ] `src/server.ts` exports `GET /embed/pulse.html` (no auth -
      public route, mounted BEFORE the `path.startsWith("/api/")`
      auth gate per the 0054 /pulse posture) renders a self-
      contained 300x180px HTML page. NO `<script>` tag. NO
      reference to `/api/control/`. NO operator project list.
      Content-Type `text/html; charset=utf-8`. Sets `Cache-
      Control: max-age=300` (5min - the embed updates faster than
      /pulse's 1h because the embedded surface stays "live"
      across page-reload boundaries on the embedder's side). Per
      LESSONS section "defence-in-depth secret redaction at the
      renderer boundary" passes through redactSecrets at the
      renderer boundary. Per LESSONS 2026-06-10 "redactSecrets on
      a JSON body shreds your KEYS" - this is HTML (not JSON) so
      the body-string redaction is appropriate; assert the page
      STRUCTURE (the 300x180px container, the three stat blocks,
      the footer link) survives the redaction pass. Sets
      `X-Frame-Options: SAMEORIGIN` by default (a config knob
      widens it - see AC4). Sets `Content-Security-Policy:
      frame-ancestors 'self'` matching the X-Frame-Options. The
      card renders three stat blocks (merged PRs, $ spent,
      $/PR) with `data-testid="embed-pulse-prs"`,
      `data-testid="embed-pulse-spend"`, `data-testid="embed-
      pulse-cost-per-pr"` plus a footer with `data-testid="embed-
      pulse-cta"` (the "powered by fleet-control" link). Per
      LESSONS 2026-06-12 "greedy `[^>]+id=` regex" - the tests
      anchor on the data-testid attribute, NOT a greedy `id=`
      match. Test: hit without auth -> 200 with three stat
      testids; assert no operator project slug appears; assert
      X-Frame-Options header present.

- [ ] `GET /embed/pulse.svg` (no auth - public route) renders the
      SAME three stats as a hand-rolled SVG image (per the 0015
      badge precedent - NO template engine, NO new dep). 300x180px
      `<svg>` viewBox, three text rows, the week-of date at the
      bottom, footer link as a clickable `<a>` element inside the
      SVG (works in browsers; gracefully degrades in image
      contexts like GitHub README which strips clickable SVG).
      Content-Type `image/svg+xml`. Cache-Control max-age=300.
      Test: hit without auth -> 200 with content-type `image/
      svg+xml`; assert the SVG contains the three stat numbers;
      assert no operator project slug appears in the SVG source.

- [ ] Honest empty state: when `fleetWeeklyPulse()` returns
      `merged_prs: 0` for the most-recent complete week, both the
      HTML and SVG embeds render "fleet is quiet this week -
      nothing shipped" inside the same dimensions, NEVER a
      fabricated upbeat line. Per CROSS_LESSONS section courtiq
      share-flow authenticity 2026-05-25 family, honest empty-
      states earn trust. Test: seed a fixture with zero merged
      PRs this week; assert both the HTML and SVG render the
      quiet-week sentence.

- [ ] Embed-origin allowlist via config: a new optional config
      field `embedOrigins: string[]` in `fleet-control.config.
      json` widens the `X-Frame-Options` and `Content-Security-
      Policy: frame-ancestors` headers to include the listed
      origins (e.g. `["https://operator.dev",
      "https://github.com"]`). When omitted (default), the
      headers are `SAMEORIGIN` / `'self'` so the embed renders
      ONLY on the operator's own host. PRODUCER-VS-SPEC NOTE:
      grep `src/config.ts` for the existing config field shape
      and place the new field in the same shape. Per LESSONS
      2026-06-11 "startServer() tests that mutate `fleet-
      control.config.json` race against parallel test files;
      expose a renderer-direct seam for branch tests" - the
      embed-origin branch is exercised via a renderer-direct
      `_renderEmbedHeadersForTests(payload, {embedOrigins:
      [...]})` seam, NOT a cwd config mutation. Test: drive the
      renderer with two distinct embedOrigins configs (empty,
      and `["https://operator.dev"]`); assert the response
      headers include the correct frame-ancestors values per
      config.

- [ ] Portal embed-snippets section on `/share` (the existing
      0013 share page): a new section "embed your fleet pulse"
      renders THREE copy-to-clipboard snippets:
      - iframe HTML: `<iframe src="<host>/embed/pulse.html"
        width="300" height="180" frameborder="0"
        title="fleet-control pulse"></iframe>`
      - img HTML: `<a href="<host>/pulse"><img
        src="<host>/embed/pulse.svg" alt="fleet pulse"
        width="300" height="180"/></a>`
      - Markdown: `[![fleet pulse](<host>/embed/pulse.svg)](<host>/
        pulse)`
      Each snippet has `data-testid="embed-snippet-<kind>"` where
      kind is `iframe` / `img` / `markdown`. Each snippet has a
      copy-to-clipboard button with `data-testid="embed-copy-
      <kind>"`. The `<host>` is the operator's lan host or
      loopback - PRODUCER-VS-SPEC NOTE: grep `src/lan.ts` for the
      existing lan-host detection helper. Test: hit `/share` with
      a valid token, assert the three snippet testids are present;
      assert each carries the same `<host>` substring; assert each
      has a copy-to-clipboard button testid.

- [ ] Idempotency / caching: the embed renderer memoises the
      pulse data per tuple `(MAX(pr.fetched_at), COUNT(*) over pr
      in week, MAX(run.started_at), COUNT(*) over run in week)`.
      Per LESSONS 2026-06-07 "the pr table has no surrogate id" -
      uses `(MAX(fetched_at), COUNT(*))` NOT `MAX(id)`. Per
      LESSONS section "in-process dedup sets need an explicit
      reset hook for tests", expose
      `_resetEmbedPulseCacheForTests()` AND
      `_getEmbedPulseCacheBuildsForTests()`. Per LESSONS 2026-06-
      05 "break ingest<->server cache-invalidation cycles via a
      globalThis slot", the invalidation hook registers on
      `globalThis.__fleet_embed_pulse_invalidate__`. Per LESSONS
      section "expose a build counter for cache-hit tests, not a
      fetcher swap" the test uses the build counter. Test: two
      calls within the cache tuple assert one build; insert a
      fresh merged PR row, assert the next call rebuilds.

- [ ] Anonymisation / leak regression: a static test seeds a
      pulse fixture and asserts the rendered embed HTML AND SVG
      contain NEITHER the operator's real project slug NOR the
      operator's host. The embed surface is FLEET-level (no per-
      project breakdown), so per-project slug leaks are a
      structural bug. Test: seed three projects with leak-shaped
      slugs (`courtiq-prod`, `internal-tool-1`, `secret-x`);
      render both embeds; assert NONE of the slugs appears in
      the response body.

- [ ] Mobile / fit-to-container: the HTML embed renders cleanly
      at the exact 300x180px viewport (no overflow, no
      scrollbars, all three stats visible). At 200x100px (a
      narrower embed) the card gracefully degrades to two stats
      (PRs + $/PR) with no overflow. Per LESSONS 2026-06-11
      "startServer() tests that mutate `fleet-control.config.
      json` race against parallel test files; expose a
      renderer-direct seam" - the viewport branches are driven
      via the renderer-direct seam. Test: render the embed HTML
      at the two viewports, assert no overflow markers, assert
      stat-count matches the viewport.

- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-
      string composition. The HTML and SVG embeds are mounted
      as NET-NEW routes (no JSON-shape break to any existing
      `/api/...` route). The portal `/share` snippet section is
      additive HTML on the existing 0013 share page - no JSON
      field changes. NEW config field `embedOrigins` is
      optional, so existing configs work unchanged. No schema
      migration - composes existing `pr`, `run`, `project`
      tables plus the existing 0054 `fleetWeeklyPulse()`
      helper. Per LESSONS section "no backticks inside
      template-literal SVG / HTML template strings" -
      identifiers stay plain words inside any backtick template
      and the SVG template is a plain string (no nested
      backticks). Per LESSONS 2026-06-11 "character-window
      source greps leak into sibling helpers" - the new
      helper's comment block uses PLAIN PROSE (no backticks)
      for any identifier that a 0052-family slice-and-grep
      test might capture.

## Out of scope

- A `/embed/lessons.html` widget that embeds the lesson-of-the-
  day. v1 ships the pulse widget only; lesson embed is a
  follow-up if operator feedback demands it.
- A `/embed/badge.html` widget that wraps the existing 0015 SVG
  badge in an iframe. The badge is already an SVG and works in
  any context iframe wouldn't; widget-wrapping is duplicative.
- An embed analytics surface (impressions, click-throughs).
  Analytics violate the no-phone-home posture.
- A "customise your embed" surface (operator picks colors,
  shows / hides stats). v1 is fixed-layout for distribution
  consistency; customisation is a follow-up.
- A non-pulse-cadence variant (e.g. monthly embed showing
  /receipts data). v1 is weekly-cadence only; monthly is a
  follow-up tied to 0041.
- An OG-image variant for social sharing. The /pulse URL
  already 200s and crawlers extract a preview; a dedicated
  og-image is a follow-up to widen the linkedin/twitter
  card surface.
- A copy-snippet UI on the public /pulse page. The embed
  snippets live on the AUTHENTICATED `/share` page only -
  the public page is for READERS, not embedders.
- Embed-host-allowlisting via OAUTH-style verification. The
  config-file allowlist is the v1 mechanism; cross-origin
  oauth is out of scope.

## Engineering notes

- `src/server.ts` - two new handlers near the existing
  `/pulse` / `/lessons-public` / `/calculator` routes:
  `GET /embed/pulse.html` (HTML, public, no auth) AND
  `GET /embed/pulse.svg` (SVG, public, no auth). Both
  MUST mount BEFORE the `path.startsWith("/api/")` auth
  gate so they share the /pulse no-auth posture. Per
  LESSONS 2026-06-05 "break ingest<->server cache-
  invalidation cycles via a globalThis slot", the
  invalidation function registers on
  `globalThis.__fleet_embed_pulse_invalidate__` from
  `src/server.ts` on module load; the ingest pass reads
  it lazily after a fresh `pr` row lands.
- `src/views.ts` OR a new `src/embed.ts` - the embed
  renderer composes `fleetWeeklyPulse()` output into a
  300x180px HTML container AND a 300x180px SVG. The
  SVG is hand-rolled (per the 0015 badge precedent) -
  NO template engine, NO new dep. Per LESSONS 2026-06-
  11 "startServer() tests that mutate `fleet-control.
  config.json` race against parallel test files; expose
  a renderer-direct seam" - expose
  `_renderEmbedPulseHtmlForTests(payload, opts?:
  {viewportWidth?: number, embedOrigins?: string[]})`
  and `_renderEmbedPulseSvgForTests(payload)` seams so
  every AC branch is driven directly, NOT through a cwd
  config mutation.
- `src/config.ts` - new optional `embedOrigins: string[]`
  field. PRODUCER-VS-SPEC NOTE: grep `src/config.ts`
  for the existing field shapes (`projectRoots`,
  `installedRoot`, etc.) and place the new field with
  the same JSON-schema-ish defaulting (empty array when
  omitted; do NOT introduce a new config format).
- `web/app.js` - one new section on the existing /share
  page (per 0013) titled "embed your fleet pulse"
  rendering three copy-to-clipboard snippets. The
  snippets are rendered at request time from the
  operator's lan host (per 0032 / `src/lan.ts`). Per
  LESSONS 2026-06-12 "greedy `[^>]+id=` regex over a
  `<h2 id="..." data-testid="...">` captures the wrong
  attribute" - the snippet testids carry distinctive
  prefixes (`embed-snippet-iframe`, etc.) so any test
  scraping the rendered HTML anchors on the data-
  testid attribute, not a greedy `id=` match.
- `web/style.css` - one selector group for the
  embed-snippets section AND one for the /embed/pulse.
  html iframe content (the latter must be self-
  contained CSS - the iframe can't share the portal's
  stylesheet). Reuse existing CSS variables for color
  and font; do NOT add new ones. The embed page's CSS
  is INLINED in a `<style>` tag inside the rendered
  HTML so the iframe needs zero extra HTTP requests.
- `tests/embed-pulse.test.ts` (new) - one `test(...)`
  per AC checkbox. Per LESSONS section "time-pinned
  tests must NOT derive seed timestamps from `new
  Date()`", every seed anchors to the pinned `now`.
  Per LESSONS section "in-process startServer() tests
  need an empty-roots config + run-row seeds", server-
  boot tests plant a tmp `fleet-control.config.json`
  in cwd. Per LESSONS 2026-06-11 "startServer() tests
  that mutate `fleet-control.config.json` race
  against parallel test files; expose a renderer-
  direct seam" - viewport / honest-empty / embed-
  origin branches drive the renderer directly, NOT
  via cwd config mutation. Per LESSONS section "no
  shell-string exec static checks should grep the
  import, not the call site" - the leak-regression
  test greps the rendered response body string.
- Schema migration: NO new tables. Composes existing
  `pr`, `run`, `project` tables plus the existing
  0054 `fleetWeeklyPulse()` helper.
- No new runtime deps. Pairs with 0015 (badge SVG -
  the project-level viral artifact; this widget is
  the FLEET-level counterpart), 0054 (pulse URL -
  same data source, different consumption surface),
  0041 (receipts - sibling share artifact), 0013
  (share page - the embed-snippets section's host),
  0032 (lan host detection for the snippet URLs),
  0051 (calculator - the click-through landing page
  from the embed footer link).

## Implementation log

(Appended by the implementation-dev agent during execution.)
