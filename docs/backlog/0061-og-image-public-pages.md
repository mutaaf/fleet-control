---
id: 0061
title: Open-graph image renderer for /pulse /receipts /calculator - every paste on LinkedIn / Twitter / Bluesky becomes a live rendered card so the share itself is the impression
status: in-progress
priority: P1
area: portal
created: 2026-06-15
owner: gtm-innovation
---

## User story

As a fleet operator who already shares the public /pulse (0054), /receipts
(0041), and /calculator (0051) URLs on LinkedIn / Twitter / Bluesky when a
ship lands but watches the share render as a generic "fleet-control" text
preview with no numbers, I want each of those three public pages to expose
a stable `og:image` URL (a 1200x630 PNG-shaped SVG card) that renders THIS
WEEK's actual fleet numbers, so that every paste of /pulse on a feed shows
the live card preview to every scroller - and the share itself becomes the
impression, not a click-through gate.

## Why now (four lenses)

### Product Owner

0060 just shipped a 300x180 embeddable pulse widget for blog sidebars and
READMEs. The natural sibling - explicitly listed in 0060's out-of-scope as
"An OG-image variant for social sharing... a follow-up to widen the
linkedin/twitter card surface" - is the SOCIAL-FEED equivalent: a
1200x630 image at a stable URL that LinkedIn / Twitter / Bluesky / Mastodon
all auto-fetch when their crawler scrapes the page's `<meta property=
"og:image">` tag. Today's /pulse, /receipts, and /calculator pages render a
generic text preview because none of them ship the `og:image` / `twitter:
card` meta tags AND none of them serve a card-shaped image at any URL.

The smallest meaningful unit of value: THREE new public routes
(`/og/pulse.svg`, `/og/receipts.svg`, `/og/calculator.svg`) each rendering
a 1200x630 hand-rolled SVG composed from the corresponding helper's
existing output (`fleetWeeklyPulse()`, the receipts monthly aggregator,
the calculator's median-shaped projection), PLUS three meta-tag insertions
on the existing public pages so every social crawler auto-picks the
image. The SVG is hand-rolled (per the 0015 badge + 0060 embed precedent -
NO template engine, NO new dep) at 1200x630px which is the LinkedIn /
Twitter / OpenGraph standard aspect (1.91:1).

The three cards are SHAPE-DIFFERENT (each surface tells a different story):

1. `/og/pulse.svg` - three giant stat blocks (PRs / spend / $/PR) plus
   the "fleet pulse - week of <ISO>" header and a footer "powered by
   fleet-control". Same data source as 0054 + 0060 (the
   `fleetWeeklyPulse()` helper).
2. `/og/receipts.svg` - one giant headline number ("this month: <N> PRs
   shipped at $<X>") plus a 6-month trailing sparkline (12 monthly bars
   rendered as `<rect>` elements - hand-rolled like 0031). Same data
   source as 0041 `/receipts`.
3. `/og/calculator.svg` - the median-projection summary ("operators like
   you save ~<H>h/week") with one prominent CTA. Same data source as
   0051 `/calculator`.

The three existing public pages each grow ONE `<head>` block with
`<meta property="og:image" content="<host>/og/<surface>.svg">`,
`<meta property="og:image:width" content="1200">`, `og:image:height`,
`twitter:card content="summary_large_image"`, `twitter:image`. The meta
tags are STATIC strings derived from the request's host header (so a LAN
operator's host gets picked up automatically; the `<host>` derivation
mirrors the 0060 snippet-rendering pattern).

PRODUCER-VS-SPEC NOTE: per LESSONS 2026-06-05 "groomer prose can disagree
with the schema; the schema wins" the implementing dev MUST grep
`src/views.ts` for `fleetWeeklyPulse()` (0054 helper) AND
`src/receipts.ts` for the monthly-rollup helper AND `src/views.ts` for the
calculator helper (0051) for the actual output field names before
composing the SVG. Per LESSONS 2026-06-10 "PRODUCER-VS-SPEC for column-
value casing" - the `pr.state` literal is `'open'` (lower) and `'MERGED'`
(upper) per the existing `src/ingest/prs.ts` writer; grep
`src/ingest/prs.ts` before writing any SELECT against `pr.state`.

### Stakeholder

Widens the moat on the SOCIAL-FEED IMPRESSION axis - the cheapest
distribution surface for any tool because the operator's act of sharing IS
the impression. 0060 widget invests in BLOG-SIDEBAR distribution
(permanent, low-traffic, high-trust); the OG image invests in SOCIAL-FEED
distribution (ephemeral, high-traffic, high-impulse). They're orthogonal
acquisition channels. Per the cross-fleet courtiq lesson "the artifact
that lives on the audience's surface, not yours, is the cheapest
distribution shape" (CROSS_LESSONS section courtiq share-flow authenticity
2026-05-25 family), the OG image is exactly that artifact applied to the
single most common share gesture - pasting a URL into a feed.

The structural moat: no SaaS dashboard publishes a public, live, share-
card image without auth because they all want a click-through-to-signup.
fleet-control's local-only posture INVERTS that calculus - the operator's
own social audience is the only audience, so the card is free to show the
real numbers. Every paste becomes a rendered impression with the
fleet-control attribution stitched into the card footer.

The screenshot worth sharing: a LinkedIn timeline scroll where the
operator's `/pulse` paste renders as a giant card with "12 PRs shipped /
$24.18 spent / $2.02 per PR / week of 2026-06-15" - a verdict only
fleet-control can author because no other tool exposes a public live
image of the operator's own fleet.

Pairs with 0060 (embed widget - same data shape, narrower viewport, blog-
sidebar surface), 0054 (pulse URL - the page the OG image attaches to),
0041 (receipts - sibling public page + OG image), 0051 (calculator -
sibling public page + OG image), 0057 (lesson archive - already a sibling
public page; OG image is a future follow-up).

### User (operator pasting on LinkedIn AND the scroller seeing it)

Two distinct users:

1. The operator (paste-and-go): copies the `/pulse` URL into LinkedIn's
   composer. LinkedIn's crawler fetches the page, reads the
   `og:image` meta tag, fetches `<host>/og/pulse.svg`, renders the
   1200x630 card preview. The operator never sees a "card looks broken"
   moment because the SVG is server-rendered fresh and ALWAYS fits the
   1200x630 frame (no overflow, no clipping). At 375px (phone composer
   view) LinkedIn auto-scales the card to a 16:9 thumbnail.

2. The scroller (their LinkedIn audience): sees the card on the feed and
   reads the three stats WITHOUT clicking. The "what is fleet-control?"
   question is answered by the footer attribution + the live numbers in
   the card. If the scroller clicks, they land on /pulse (already the
   bookmark surface per 0054). If they don't click, the impression has
   already landed.

Honest empty state: when `fleetWeeklyPulse()` returns 0 merged PRs this
week, the `/og/pulse.svg` renders "fleet is quiet this week" inside the
same 1200x630 frame - NEVER a fabricated upbeat line. Same posture as
0054 /pulse's empty state per CROSS_LESSONS section courtiq share-flow
authenticity 2026-05-25 family. Same applies to /og/receipts.svg ("no
months ingested yet - install fleet-control") and /og/calculator.svg
("calibrating - check back after a week of data").

### Growth

The "show me" moment is a LinkedIn feed scroll where every paste of
/pulse / /receipts / /calculator renders as a giant card with live
numbers - the friend scrolling through sees fleet-control's most
narrative shape without a click-through gate. Per the cross-fleet courtiq
lesson "the prospect's first impression of your tool is most likely to be
the impression LEFT BY A CURRENT USER, not by you" (CROSS_LESSONS section
courtiq Entries 2026-05-21 family on share-flow), the OG image is the
HIGHEST-FREQUENCY shape of that impression - every share gesture leaves
one. Permanent in the feed (LinkedIn / Bluesky / Mastodon cache the
preview); rendered fresh on first crawl (so the numbers are this week's,
not last week's).

A subtle but important moat property: the OG image URL is STABLE
(`/og/pulse.svg` - no query string, no slug, no token) so the LinkedIn
crawler can cache it AND the operator can paste the same URL to LinkedIn
on week 1 and week 5 and get DIFFERENT cards (because the underlying SVG
re-renders on each crawl). The cadence matches the share gesture: the
operator shares /pulse weekly, the OG image refreshes weekly. The
calculator OG image refreshes monthly (matches its slower data shape).
The receipts OG image refreshes monthly. No cache invalidation; the
upstream crawler picks the freshness up via standard HTTP semantics.

Pairs with 0015 (project-level status badge - the SAME structural moat
applied at the per-project / per-share-gesture cadence), 0013 (share
page - the operator's home base for finding the URLs to paste).

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: per LESSONS
2026-06-05 "groomer prose can disagree with the schema; the schema wins"
the implementing dev MUST grep `src/views.ts` for `fleetWeeklyPulse`,
`src/receipts.ts` for the monthly rollup helper, AND the calculator
helper in `src/views.ts` (per 0051) BEFORE writing any SELECT or
composing the SVG; the producer file is the source of truth. Per
LESSONS 2026-06-10 "PRODUCER-VS-SPEC for column-value casing" - any
literal compared to `pr.state` is `'open'` (lower) or `'MERGED'` (upper)
per the existing `src/ingest/prs.ts` writer. Per LESSONS 2026-06-07 "the
`pr` table has no surrogate id" - any cache invalidation tuple uses
`(MAX(pr.fetched_at), COUNT(*))` over `pr`, NEVER `MAX(id)`.

- [ ] `GET /og/pulse.svg` (no auth - public route, mounted BEFORE the
      `path.startsWith("/api/")` auth gate per the 0054 /pulse and 0060
      /embed posture) renders a 1200x630px hand-rolled SVG composing the
      `fleetWeeklyPulse()` output: three giant stat blocks (merged PRs,
      $ spent, $/PR), a header "fleet pulse - week of <ISO>", and a
      footer attribution. Content-Type `image/svg+xml`. Cache-Control
      `max-age=3600` (LinkedIn / Twitter crawlers re-fetch on share, so
      a 1h TTL is the right cadence). NO `<script>` tag. NO operator
      project slug in the SVG source. Each stat block carries
      `data-testid="og-pulse-prs"`, `og-pulse-spend`, `og-pulse-cost-
      per-pr` per LESSONS 2026-06-12 "greedy `[^>]+id=` regex over a
      `<h2 id="..." data-testid="...">"`. Test: hit without auth ->
      200, content-type `image/svg+xml`, the three testids appear, no
      project slug appears in the response body.

- [ ] `GET /og/receipts.svg` (no auth) renders a 1200x630px hand-rolled
      SVG composing the receipts monthly aggregator's output: one giant
      headline number ("this month: <N> PRs at $<X>") plus a 12-bar
      trailing sparkline rendered as `<rect>` elements. Same cache /
      content-type / no-script / testid posture as the pulse OG. The
      sparkline carries `data-testid="og-receipts-sparkline"`; the
      headline carries `data-testid="og-receipts-headline"`. Test: hit
      without auth -> 200, content-type svg, both testids present.

- [ ] `GET /og/calculator.svg` (no auth) renders a 1200x630px hand-rolled
      SVG composing the calculator's median-projection output: one
      headline ("operators like you save ~<H>h/week"), one CTA footer
      ("install fleet-control"), and a single stat block. Same cache /
      content-type / no-script / testid posture. The headline carries
      `data-testid="og-calc-headline"`; the CTA carries `data-testid=
      "og-calc-cta"`. Test: hit without auth -> 200, content-type svg,
      both testids present.

- [ ] Honest empty state: when the underlying helper returns zero data
      (no merged PRs for pulse, no months ingested for receipts,
      calibrating for calculator), each OG SVG renders one HONEST
      sentence inside the 1200x630 frame ("fleet is quiet this week",
      "no months ingested yet - install fleet-control", "calibrating -
      check back after a week of data") - NEVER a fabricated number.
      Per CROSS_LESSONS section courtiq share-flow authenticity
      2026-05-25 family, the OG image NEVER lies up. Test: seed three
      empty fixtures (one per surface); assert each empty-state
      sentence appears in the rendered SVG.

- [ ] The three existing public pages (`/pulse`, `/receipts`,
      `/calculator`) each grow a `<head>` block emitting `<meta
      property="og:image" content="<host>/og/<surface>.svg">`, plus
      `og:image:width="1200"`, `og:image:height="630"`,
      `twitter:card="summary_large_image"`, `twitter:image="<host>/og/
      <surface>.svg">`, `og:type="website"`, and `og:title` /
      `og:description` static strings appropriate to each surface. The
      `<host>` is derived from the request's `Host` header (per the
      existing 0060 snippet-rendering pattern in `src/lan.ts`) so a
      LAN operator's host gets picked up automatically. Each meta tag
      carries `data-testid="og-meta-<key>"`. Per LESSONS 2026-06-12
      "greedy `[^>]+id=` regex" - the meta-tag assertions anchor on
      the data-testid, not a greedy `property=` match. Test: hit each
      of the three pages without auth; assert all six meta-tag
      testids appear; assert each `content=` value contains the same
      `<host>` substring the request was served on.

- [ ] Anonymisation / leak regression: a static test seeds the three
      surfaces with leak-shaped project slugs (`courtiq-prod`,
      `internal-tool-1`, `secret-x`); renders all three OG SVGs;
      asserts NONE of the slugs appears in any of the response bodies.
      The OG image is FLEET-LEVEL (the SVG aggregates across all
      projects); per-project slug leaks are a structural bug. Per
      LESSONS 2026-06-10 "redactSecrets on a JSON body shreds your
      KEYS" - since these are SVG (not JSON), VALUE-side redaction
      (sanitise operator-supplied STRINGS like project names BEFORE
      they reach the SVG template, NOT body-string redaction over the
      finished SVG) is the appropriate posture. Test asserts the
      rendered SVG bytes do NOT contain any seeded slug substring.

- [ ] Idempotency / caching: each OG renderer memoises its payload
      behind a tuple matching its data source. Pulse OG uses
      `(MAX(pr.fetched_at), COUNT(*) over pr in week, MAX(run.
      started_at), COUNT(*) over run in week)`. Receipts OG uses
      `(MAX(pr.fetched_at), COUNT(*) over pr in month)`. Calculator OG
      uses `(MAX(run.started_at), COUNT(*) over run in trailing 90d)`.
      Per LESSONS 2026-06-07 "the `pr` table has no surrogate id" -
      uses `(MAX(fetched_at), COUNT(*))` NOT `MAX(id)`. Per LESSONS
      section "in-process dedup sets need an explicit reset hook for
      tests", export `_resetOgCacheForTests()` AND
      `_getOgCacheBuildsForTests()`. Per LESSONS 2026-06-05 "break
      ingest<->server cache-invalidation cycles via a globalThis
      slot", the invalidation hook registers on
      `globalThis.__fleet_og_invalidate__` from server.ts on module
      load AND the ingest pass reads it lazily after the COMMIT. Per
      LESSONS section "expose a build counter for cache-hit tests" -
      the test asserts the build counter goes up 1 then 0 across two
      same-tuple calls. Test: two calls within the cache tuple assert
      one build; insert a fresh merged PR row; assert the next call
      rebuilds.

- [ ] Renderer-direct seam: each OG renderer exposes
      `_renderOgPulseSvgForTests(payload, opts?)`,
      `_renderOgReceiptsSvgForTests(payload, opts?)`,
      `_renderOgCalculatorSvgForTests(payload, opts?)` so empty-state /
      sparkline / headline-shape branches are driven through the
      renderer directly, NEVER through a cwd `fleet-control.config.
      json` mutation. Per LESSONS 2026-06-11 "startServer() tests that
      mutate `fleet-control.config.json` race against parallel test
      files; expose a renderer-direct seam for branch tests" - the
      boot-path test stays valuable for the integration shape (route
      exists, content-type, cache-control, testids present) but the
      empty-state / shape branches belong in renderer-direct unit
      tests. Test: each renderer-direct call covers one branch shape
      and one empty-state shape without any HTTP boot.

- [ ] Time-pinned tests: every test fixture seeding timestamps relative
      to a pinned `now` derives its seed timestamps from the pin, never
      from `new Date()`. Per LESSONS 2026-05-29 "time-pinned tests must
      NOT derive seed timestamps from `new Date()`" - the
      week-of-pulse, month-of-receipts, and trailing-90d-calculator
      windows are all anchor-relative; a fixture authored today and
      run on a date 3 days later must STILL pass because the seeds
      derive from the anchor, not the wall clock. Test: an explicit
      assertion that re-running the test with a different system-clock
      simulation produces identical output.

- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-string
      composition (the SVG renderers compose strings via standard
      string concatenation; no `child_process` exec). The OG routes
      are NET-NEW (no JSON-shape break to any existing `/api/...`
      route). The meta-tag additions on the three public pages are
      additive HTML (no existing `<meta>` removal). NO schema
      migration - composes existing `pr`, `run`, `project`,
      `cost_rollup_day` tables plus existing
      `fleetWeeklyPulse()` / receipts / calculator helpers. Per
      LESSONS 2026-06-13 "function-import cycles aren't always cache-
      invalidation; sometimes the cheapest fix is a 6-line inline
      copy of the helper" - if the new OG module would need to import
      a helper from `src/views.ts` AND `src/views.ts` already imports
      from the OG module, inline the helper as a private copy in the
      OG module (6 lines is cheaper than the cycle audit). The
      globalThis-slot pattern stays in its lane: it's for the cache-
      invalidation hook only.

## Out of scope

- An `og:image` for `/lessons-public` (0057) or `/failures` (0058).
  Sibling follow-ups; the first three pages are the highest-share-
  frequency surfaces and a fine v1 scope.
- An `og:image` for `/embed/pulse.html` (0060). The embed widget is
  already an iframe; OG meta on an embed surface is nonsensical (the
  embed is NOT a sharable page).
- A PNG variant. The SVG renders correctly in every major social
  crawler (LinkedIn, Twitter/X, Bluesky, Mastodon all accept SVG); a
  PNG variant would require a runtime dep (sharp / canvas) which
  violates AGENTS.md zero-runtime-deps.
- A "customise your OG card" surface (operator picks colors, picks
  which stats appear). v1 is fixed-layout for distribution
  consistency; customisation is a follow-up.
- An OG image for each project's individual `/p/<slug>` page. The
  per-project surface is authenticated and not the share gesture;
  per-project OG is duplicative of the 0015 badge.
- An analytics surface (impressions, shares, click-throughs).
  Analytics violate the no-phone-home posture.
- An OG image for the home page (`/`). The home page is
  authenticated; the OG meta tags only attach to public pages.

## Engineering notes

- `src/server.ts` - three new public route handlers (`GET /og/pulse.
  svg`, `GET /og/receipts.svg`, `GET /og/calculator.svg`) mounted
  BEFORE the `path.startsWith("/api/")` auth gate, alongside the
  existing `/pulse` / `/receipts` / `/calculator` / `/embed/pulse.*`
  public routes. Each route MUST set `Cache-Control: max-age=3600`,
  `Content-Type: image/svg+xml`. The three existing public-page
  handlers (`/pulse`, `/receipts`, `/calculator`) grow ONE
  `<head>`-block emission of the og meta tags; the `<host>` is
  derived from the request `Host` header (existing helper in
  `src/lan.ts` per 0032 / 0060).
- `src/og.ts` (new module) - houses the three SVG renderers as
  pure functions (`renderOgPulseSvg(payload)`,
  `renderOgReceiptsSvg(payload)`,
  `renderOgCalculatorSvg(payload)`) plus the cache layer
  (memoised on the invalidation tuple, with the build-counter and
  reset seams). The SVGs are hand-rolled per the 0015 + 0060
  precedent (string concatenation, no template engine). Per LESSONS
  2026-06-13 "function-import cycles" - if any helper needs to be
  shared with `src/views.ts`, prefer a private inline copy over a
  `from "./views.ts"` import.
- `src/views.ts` (no change) OR `src/og.ts` reads
  `fleetWeeklyPulse()` directly. PRODUCER-VS-SPEC NOTE: grep
  `src/views.ts` for `fleetWeeklyPulse()` (per 0054) AND
  `src/receipts.ts` for the monthly rollup helper AND
  `src/views.ts` for the calculator helper (per 0051) for the
  actual output field shapes BEFORE composing the SVGs - the
  spec's prose ("merged PRs", "$ spent") is a HINT, the producer
  helper's field names are the contract.
- `web/style.css` - NO new selectors. The OG SVGs are self-
  contained (inline `<style>` inside the SVG, or attribute styling)
  so they need zero portal CSS.
- `tests/og-images.test.ts` (new) - one `test(...)` per AC
  checkbox. Per LESSONS section "time-pinned tests must NOT
  derive seed timestamps from `new Date()`", every seed anchors
  to a pinned `now`. Per LESSONS 2026-06-11 "startServer() tests
  that mutate `fleet-control.config.json` race against parallel
  test files; expose a renderer-direct seam" - shape / empty-
  state / sparkline branches drive the renderer directly via the
  `_render*ForTests` seams, NOT via cwd config mutation.
- Schema migration: NO. Composes existing `pr`, `run`, `project`,
  `cost_rollup_day` tables plus the existing 0054 / 0041 / 0051
  helpers. No new globalThis slot beyond
  `__fleet_og_invalidate__`.
- No new runtime deps. Lean on `node:sqlite`, `node:http`, the
  standard library. Pairs with 0060 (embed widget - same data
  shape, narrower viewport, blog-sidebar surface; the OG image is
  the social-feed counterpart), 0054 (pulse URL - the page the
  pulse OG attaches to), 0041 (receipts page), 0051 (calculator
  page), 0015 (project badge SVG - the per-project share artifact;
  the OG image is the fleet-level public-page counterpart), 0013
  (share page - where the operator copies the URL to paste).

## Implementation log

- 2026-06-15 — implementation-dev: started on
  `feat/0061-og-image-public-pages`. Plan: new `src/og.ts` with three
  pure SVG renderers (pulse, receipts, calculator) following the 0060
  embed precedent — hand-rolled SVG strings, no template engine, no
  new dep; renderer-direct seams `_renderOgPulseSvgForTests`,
  `_renderOgReceiptsSvgForTests`, `_renderOgCalculatorSvgForTests`
  for branch tests per LESSONS 2026-06-11. Three new routes in
  `src/server.ts` mounted BEFORE the `/api/` auth gate alongside
  `/embed/pulse.*` (1h Cache-Control, image/svg+xml content-type),
  plus a meta-tag block injected into the three existing public-page
  HTML responses keyed off the request Host header. Cache layer
  memoises each renderer behind the documented tuple
  (pulse: MAX(pr.fetched_at) + COUNT + MAX(run.started_at) + COUNT
  in week; receipts: MAX(pr.fetched_at) + COUNT in month; calculator:
  MAX(run.started_at) + COUNT in trailing 90d) — per LESSONS
  2026-06-07 the tuple uses (MAX(fetched_at), COUNT(*)) NOT
  MAX(pr.id). Ingest invalidation hook registers on
  `globalThis.__fleet_og_invalidate__` per LESSONS 2026-06-05; any
  helper needs from views.ts get inlined per LESSONS 2026-06-13 to
  avoid the function-import cycle.
