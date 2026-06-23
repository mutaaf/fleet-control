---
id: 0073
title: Public sitemap.xml plus robots.txt plus an /lessons-public/feed.xml RSS atom feed - one set of cold-discovery surfaces that lets a search engine index every public page already shipped (pulse, receipts, calculator, lessons, lessons-lineage, failures, operator, referrals) and lets a curious reader subscribe to new lessons in their feed reader so the moat of accumulated public artifacts finally becomes discoverable by strangers who never saw the operator's share post
status: groomed
priority: P1
area: portal
created: 2026-06-23
owner: gtm-innovation
---

## User story

As a fleet operator who has SEVENTEEN public surfaces already shipped
(`/pulse`, `/receipts`, `/calculator`, `/lessons-public/`,
`/lessons-public/<slug>`, `/lessons-public/<slug>/lineage` per 0069,
`/failures/<signature>` per 0058, `/operator/<handle>` per 0065,
`/referrals/<handle>` per 0068, `/year/<YYYY>` per 0050, and the embed /
OG siblings) but whose entire SEO surface today is whatever links the
operator manually pasted into Slack / Bluesky / LinkedIn, who would
LOVE for Google / Bing / DuckDuckGo to index those pages so a stranger
Googling "node:sqlite no such column" lands on the operator's
`/lessons-public/no-such-column-id-on-pr-table` page WITHOUT the
operator having posted that link anywhere, AND who knows from running
two other repos that "add a sitemap + robots.txt + an RSS feed" is the
SINGLE intervention that turns a portfolio of public pages into a
compounding cold-discovery surface, I want one new public route family
- `GET /sitemap.xml` enumerating every public surface anchored on the
`cfg.operator?.publicHost` field, `GET /robots.txt` allowing crawlers
on the public prefixes and disallowing `/api/` + the loopback portal,
and `GET /lessons-public/feed.xml` shaping the 50 most-recent lessons
as an Atom 1.0 feed - so the strangers who never saw my share post
still find their way to the operator-attributed moat artifacts the
fleet has been authoring, and the existing 0058 SEO ambition for
`/failures/` and the 0057 SEO ambition for `/lessons-public/` finally
gets the indexing infrastructure they need to actually rank.

## Why now (four lenses)

### Product Owner

0054 ships `/pulse`. 0041 ships `/receipts`. 0051 ships `/calculator`.
0057 ships `/lessons-public/` + `/lessons-public/<slug>`. 0058 ships
`/failures/<signature>`. 0065 ships `/operator/<handle>`. 0068 ships
`/referrals/<handle>`. 0069 ships `/lessons-public/<slug>/lineage`.
0050 ships `/year/<YYYY>`. 0061 ships `/og/...` SVG renderers. EACH of
those surfaces is a public page the operator can SHARE - but a
stranger Googling the right error string today CANNOT FIND any of
them because there is NO sitemap.xml telling search engines the pages
exist, NO robots.txt scoping the crawl to public surfaces, NO RSS
feed for a curious reader to subscribe to lessons or pulses. The
existing SEO ambitions (0058 explicitly names "anonymised `/failures/
<signature>` SEO surface" - 0057 names "anonymised /lessons-public
surface where a stranger Googling a node:sqlite error lands and
downloads fleet-control") are STRUCTURALLY blocked by the missing
discovery infrastructure.

The smallest meaningful unit of value: THREE new public routes that
compound across EVERY existing public surface:

1. **`GET /sitemap.xml`** - enumerates every public URL on this
   instance. The sitemap is composed deterministically from existing
   SQL surfaces:
     - The fixed pages `/pulse`, `/receipts`, `/calculator`,
       `/lessons-public/`, `/year/<latest>`,
       `/operator/<handle>` (when set), `/referrals/<handle>`
       (when set).
     - Every `/lessons-public/<slug>` (one row per
       `lessonsPublicArchive` entry per 0057).
     - Every `/lessons-public/<slug>/lineage` (one row per
       lesson with `totals.catches >= 2` per 0069 - the
       singleton-catch branch's empty-state pages are excluded
       so the sitemap doesn't surface "warming up" pages).
     - Every `/failures/<signature>` (one row per
       `fleetFailureModes` entry per 0058).
   PRODUCER-VS-SPEC NOTE per LESSONS 2026-06-05: the
   implementing dev MUST grep `src/views.ts` for the EXACT
   helper names `lessonsPublicArchive` (per 0057),
   `fleetFailureModes` (per 0058 per LESSONS 2026-06-13's
   inline anonymisation reconciliation), and the
   `cfg.operator?.publicHost` field (per 0061 / 0065 / 0066).
   The sitemap helper is a NEW pure function alongside the
   existing payload helpers in `src/views.ts` (no new
   module - per LESSONS 2026-06-13 a new module is the right
   call ONLY when the new function shares no SQL surface
   with views.ts; the sitemap reads every public payload
   helper, so views.ts is the natural home). The
   `<lastmod>` field per URL uses the existing
   `(MAX(fetched_at), COUNT(*))` proxy per LESSONS 2026-06-07
   so a freshly-merged PR busts the cache identically across
   sitemap + all public payloads. Per LESSONS 2026-05-26 NO
   backticks inside the SCHEMA-template-adjacent SQL
   reads (the sitemap reads existing tables only - no
   schema change).

2. **`GET /robots.txt`** - serves a plain-text response:
   ```
   User-agent: *
   Allow: /pulse
   Allow: /receipts
   Allow: /calculator
   Allow: /lessons-public/
   Allow: /failures/
   Allow: /operator/
   Allow: /referrals/
   Allow: /year/
   Allow: /share/
   Allow: /og/
   Allow: /embed/
   Allow: /sitemap.xml
   Disallow: /api/
   Disallow: /
   Sitemap: <publicHost>/sitemap.xml
   ```
   The `Disallow: /` ensures the loopback portal (home, /p/,
   /r/) stays out of search indexes - the portal is operator-
   private. The Allow rules SUPERSEDE the Disallow per the
   robots.txt spec when the Allow path is more specific
   (longer prefix). The `Sitemap:` line uses
   `cfg.operator?.publicHost` per the 0061 / 0065 composition
   pattern (absolute when set; falls back to Host header).
   Per LESSONS 2026-06-15 the `User-agent: *` block is a
   single literal line (no prose comment that could trip a
   greedy regex test against the response body).

3. **`GET /lessons-public/feed.xml`** - serves an Atom 1.0
   feed of the 50 most-recent lessons from the existing
   `lessonsPublicArchive` (per 0057). Each `<entry>` carries:
     - `<id>` = `<publicHost>/lessons-public/<slug>`.
     - `<title>` = the lesson's anonymised title (reusing
       the existing private inline `anonymiseExcerpt` in
       views.ts per LESSONS 2026-06-13).
     - `<updated>` = the lesson_credit MAX(created_at)
       for that slug (so the feed reader reorders correctly
       when a stale lesson catches a new bug).
     - `<summary>` = the anonymised lesson excerpt
       (first 280 chars).
     - `<link href="..." rel="alternate" />` to
       `/lessons-public/<slug>`.
   The Atom self-link `<link rel="self">` points at
   `/lessons-public/feed.xml`. Per CROSS_LESSONS 2026-06-15
   on `[^/>]*` rejecting valid attribute values - if a test
   greps the feed's tag attributes, use `[^>]*` NOT `[^/>]`
   so paths/MIME-types in attribute values (`type=
   "application/atom+xml"`) match correctly.

Per LESSONS 2026-06-15 each new route mounts BEFORE the
`/api/` auth gate (the static-grep ordering anchor is the
EXACT `if (path.startsWith("/api/"))` shape). Per LESSONS
2026-06-15 a doctor check `checkSitemapPublicHost` would
sit INSIDE the `if (!opts.offline)` branch if added
(but the doctor extension is out of scope per the
"don't widen surfaces" discipline; future ticket).

### Stakeholder

Widens the moat on the COLD-DISCOVERY axis where 17
public surfaces today depend ENTIRELY on the operator
manually pasting links. The reasoning:

- Every existing share surface (0067 fleetctl share, 0068
  referral graph, 0066 stakeholder URL, 0070 portfolio
  export, 0071 reactivation push) is a PUSH channel - the
  operator sends, the receiver clicks. None of them is a
  PULL channel where a stranger ARRIVES from a search
  engine on their own intent.
- The cross-fleet courtiq lesson "the highest-leverage
  acquisition surface is the one that converts a STRANGER
  with a SPECIFIC problem - someone Googling 'sqlite
  julianday precision drift' is more qualified than 1000
  cold subscribers because their intent is specific and
  their first impression of fleet-control is solving
  their exact problem" (CROSS_LESSONS section courtiq
  Entries 2026-05-21 family on intent-as-qualification)
  applies directly: the 0058 / 0057 SEO ambition is the
  highest-converting cold surface available, and its
  blocker today is purely infrastructural - the missing
  sitemap / robots / feed.
- The compounding property: every NEW lesson the fleet
  authors, every NEW failure-mode landing page, every
  NEW operator profile gets indexed by Google within 7
  days because the sitemap dynamically enumerates them.
  The moat compounds without operator effort - the
  fleet authors the artifact, the sitemap surfaces it,
  the search engine indexes it, the stranger arrives.
  This is the SINGLE intervention that converts the
  accumulated-history moat into a cold-acquisition
  funnel.

The hosted-competitor structural gap: a hosted
observability vendor's sitemap surfaces THEIR product
pages (pricing, features, blog posts). Each
fleet-control instance's sitemap surfaces the
OPERATOR's accumulated artifacts. The long-tail SEO
footprint is per-operator, not per-vendor - which
means every operator with a `publicHost` set is
authoring SEO ground a hosted competitor cannot match
because they don't have the operator's authentic
lessons / failures / receipts / pulses to surface.

The "show me" moment worth a screenshot: a Google
Search Console screenshot showing the operator's
public surfaces indexed - 150 URLs surfaced, 47 of
them already ranking for long-tail queries like
"julianday drift sqlite" / "node:sqlite no such
column id". Every reader of that screenshot
recognises this is what SEO looks like when the
underlying artifacts are real.

Pairs with 0054 (pulse), 0041 (receipts), 0051
(calculator), 0057 (lessons archive), 0058
(failures), 0065 (operator profile), 0068
(referrals), 0069 (lesson lineage), 0050
(year-in-review), 0061 (OG infra - the sitemap
surfaces drive the OG previews when shared),
0064 (rate-limit on the new public routes).

### User (operator at 9am, looking at the portal)

Three operator scenarios:

1. **Daily glance** (zero impact): the portal home is
   UNCHANGED. The sitemap / robots / feed are public
   infrastructure, not operator-facing cards. The
   operator never lands on `/sitemap.xml` from their
   own daily rhythm.

2. **The set-publicHost moment** (one-time, < 60s):
   the operator sets `operator.publicHost:
   "https://fleet.mutaaf.dev"` in
   `fleet-control.config.json` (the field already
   exists per 0061 / 0065). The sitemap now emits
   absolute URLs. The operator submits the sitemap
   URL to Google Search Console once.

3. **The cold-discovery moment** (the high-leverage
   compounding moment, weeks later): a stranger
   Googles "julianday precision drift sqlite", lands
   on the operator's `/lessons-public/julianday-
   drift-sqlite-decompose-strftime` page, reads the
   anonymised lesson, clicks the install footer.
   The operator never authored a single share for
   this conversion - the sitemap did the work.

Per LESSONS 2026-06-11 the renderer-direct seam
`_renderSitemapForTests(payload, opts)` exercises
the publicHost-set / publicHost-unset / empty-fleet
branches without cwd config mutation. Per LESSONS
2026-06-19 any test that needs `loadConfig()` with
a `operator.publicHost` set runs the parser in a
subprocess pinned to a tmpdir cwd via `spawnSync` -
NEVER writes to the test runner's shared cwd's
`fleet-control.config.json`.

### Growth

The growth bet: cold discovery is the single growth
surface fleet-control has not yet invested in,
despite shipping 17 public surfaces. The leverage
ratio is asymmetric - one sitemap.xml + one robots.txt
+ one feed.xml unlocks indexing for EVERY current
and future public page. Per the cross-fleet courtiq
lesson "the highest-leverage SEO intervention is
ALWAYS the discovery infrastructure (sitemap +
robots + feed), not the content - a portfolio of
17 unindexed pages becomes a portfolio of 17 indexed
pages with one 200-line patch, and the compounding
SEO accumulation begins on the day of merge"
(CROSS_LESSONS section courtiq Entries 2026-05-21
family on discovery-infrastructure-leverage, AND the
digitalcraft section's 2026-05-22 lesson on
mirror-source single-source-of-truth for sitemap
lastmod), the sitemap surface is the single most
asymmetric ROI surface available to fleet-control
today.

A second growth surface: RSS readers. The
`/lessons-public/feed.xml` lets a curious developer
subscribe in NetNewsWire / Feedly / Reeder /
Inoreader and get every new fleet lesson as it
lands. This is a HIGHER-QUALITY acquisition cohort
than social-share clicks because RSS subscribers
self-selected for ongoing interest. The OG image
(0061) plus a fresh lesson per week creates a
weekly impression cadence the operator never has
to author.

A subtle moat property: the sitemap content
compounds invisibly. An operator who has been on
fleet-control for 12 months has 100+ lesson URLs
indexed; an operator who installed last week has 0.
The accumulated lesson-page indexed-footprint IS
the moat, and the sitemap is what makes the moat
visible to search engines.

Per the cross-fleet digitalcraft lesson 2026-05-22
"sitemap freshness drives crawl frequency; stale
lastmod tells Google to skip the page on its next
crawl - keep the lastmod tied to the actual
content's most-recent edit, not the build time"
(CROSS_LESSONS digitalcraft 2026-05-22 family on
mirror-source for sitemap), the `<lastmod>` in
this sitemap is the per-page content timestamp
(MAX(lesson_credit.created_at) for lessons,
MAX(pr.fetched_at) for failure modes, etc) NOT
the sitemap-render timestamp - so Google's crawl
budget targets the freshly-changed pages.

Pairs with 0057 (lessons archive - the feed's
content source), 0058 (failures - the sitemap's
biggest surface family), 0054 / 0041 / 0051
(pulse / receipts / calculator), 0065 / 0068 / 0069
(operator / referrals / lineage), 0061 (OG card -
each indexed page renders its OG card when
shared), 0064 (rate-limit on /sitemap.xml /
/robots.txt / /lessons-public/feed.xml).

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] New helper `fleetSitemapPayload(db, cfg, now)` in
      `src/views.ts` returns `{ urls: Array<{ loc:
      string, lastmod: string, changefreq:
      'daily' | 'weekly' | 'monthly', priority:
      number }>, asOf: string, version: 1 }`. The
      helper composes the urls list from existing
      payload helpers:
        - Fixed: `/pulse`, `/receipts`, `/calculator`,
          `/lessons-public/`, `/year/<latest>`.
        - Conditional: `/operator/<handle>` AND
          `/referrals/<handle>` when
          `cfg.operator?.handle` is set.
        - Dynamic from `lessonsPublicArchive(db, now)`:
          one `/lessons-public/<slug>` URL per entry.
        - Dynamic from `lessonLineagePayload(db,
          slug, now)`: one `/lessons-public/<slug>/
          lineage` URL per slug where
          `totals.catches >= 2` per 0069's gate.
        - Dynamic from `fleetFailureModes(db, now)`:
          one `/failures/<signature>` URL per entry.
      Each `loc` uses the `cfg.operator?.publicHost`
      prefix when set; falls back to a relative URL
      when unset. PRODUCER-VS-SPEC NOTE per LESSONS
      2026-06-05: grep `src/views.ts` for the EXACT
      helper names (`lessonsPublicArchive`,
      `fleetFailureModes`, `lessonLineagePayload`)
      and signature shapes. Test: seed a fleet with
      3 lessons + 2 failure modes + an operator
      handle set; assert `urls.length` equals the
      fixed (5) + conditional (2) + dynamic (3 + 0
      lineage + 2 = 5) = 12.

- [ ] New public route `GET /sitemap.xml` in
      `src/server.ts` renders a Sitemap 0.9 XML
      document from `fleetSitemapPayload`. Content-
      Type `application/xml; charset=utf-8`. The
      document starts with `<?xml version="1.0"
      encoding="UTF-8"?>` and a `<urlset xmlns=
      "http://www.sitemaps.org/schemas/sitemap/
      0.9">` root. Each `<url>` has `<loc>`,
      `<lastmod>`, `<changefreq>`, `<priority>`.
      Route mounts BEFORE the `/api/` auth gate
      per LESSONS 2026-06-15 (static-grep anchors
      on the EXACT `if (path.startsWith("/api/"))`
      shape). Test: hit the route on a seeded
      fleet; assert 200 + Content-Type + the
      response body contains
      `<urlset xmlns="http://www.sitemaps.org/
      schemas/sitemap/0.9">` AND each seeded
      lesson's slug appears in a `<loc>`.

- [ ] Sitemap `<lastmod>` correctness: each url's
      `<lastmod>` is the content-source MAX
      timestamp (lessons use MAX(lesson_credit.
      created_at) WHERE lesson_slug=?; failure
      modes use MAX(pr.fetched_at) WHERE
      signature=?; the fixed pages use the
      ingest watermark via `(MAX(pr.fetched_at),
      COUNT(*) FROM pr)` per LESSONS 2026-06-07).
      Per the cross-fleet digitalcraft lesson
      2026-05-22 the lastmod is the CONTENT
      timestamp NOT the render timestamp. Test:
      seed a lesson with a fixed lesson_credit
      row; render the sitemap; assert the
      `<lastmod>` value equals the seeded row's
      created_at.

- [ ] New public route `GET /robots.txt` in
      `src/server.ts` renders a plain-text
      response with Content-Type
      `text/plain; charset=utf-8`. Body:
      ```
      User-agent: *
      Allow: /pulse
      Allow: /receipts
      Allow: /calculator
      Allow: /lessons-public/
      Allow: /failures/
      Allow: /operator/
      Allow: /referrals/
      Allow: /year/
      Allow: /share/
      Allow: /og/
      Allow: /embed/
      Allow: /sitemap.xml
      Disallow: /api/
      Disallow: /
      Sitemap: <publicHost>/sitemap.xml
      ```
      Where `<publicHost>` is `cfg.operator?.publicHost`
      or the Host header. Route mounts BEFORE the
      `/api/` auth gate per LESSONS 2026-06-15. Test:
      hit the route; assert 200 + Content-Type + the
      response body matches the expected literal
      block.

- [ ] New public route `GET /lessons-public/feed.xml`
      in `src/server.ts` renders an Atom 1.0 feed of
      the 50 most-recent entries from
      `lessonsPublicArchive`. Content-Type
      `application/atom+xml; charset=utf-8`. The
      root `<feed xmlns="http://www.w3.org/2005/
      Atom">` carries `<title>`, `<id>` (the
      publicHost URL), `<link rel="self"
      href=".../lessons-public/feed.xml" />`,
      `<link rel="alternate" href=".../lessons-
      public/" />`, `<updated>` (the latest
      lesson_credit MAX(created_at) across all
      lessons), and one `<entry>` per lesson. Per
      CROSS_LESSONS 2026-06-15 (digitalcraft) any
      regex test on the feed's tag attributes uses
      `[^>]*` NOT `[^/>]*` to allow MIME-types and
      paths in attribute values. Route mounts
      BEFORE the `/api/` auth gate per LESSONS
      2026-06-15. Test: seed 3 lessons; hit the
      route; assert 200 + Content-Type + the
      response body contains
      `<feed xmlns="http://www.w3.org/2005/Atom">`
      AND 3 `<entry>` elements.

- [ ] Feed `<entry>` content: each entry has
      `<id>`, `<title>`, `<updated>`, `<summary>`,
      `<link href="..." rel="alternate" />`. The
      `<title>` uses the anonymised lesson title
      via the existing inline `anonymiseExcerpt`
      in views.ts per LESSONS 2026-06-13 (no new
      `from "./lessons.ts"` import; reuse the
      6-line private helper). The `<summary>` is
      the first 280 anonymised chars of the
      lesson body. Test: seed a lesson with a
      raw body containing a `/Users/mutaaf/code`
      path; assert the rendered `<summary>` does
      NOT contain the literal path (the
      anonymisation collapsed it to a placeholder).

- [ ] publicHost-unset branch: when
      `cfg.operator?.publicHost` is undefined, the
      sitemap renders RELATIVE URLs (`/pulse`,
      `/lessons-public/<slug>`) and the robots.txt's
      `Sitemap:` line uses the Host header as the
      origin. Per LESSONS 2026-06-11 the renderer-
      direct seam `_renderSitemapForTests(payload,
      opts)` exercises the publicHost-unset branch
      without cwd config mutation. Test: drive
      `_renderSitemapForTests` with `publicHost:
      undefined`; assert every `<loc>` is relative.

- [ ] Empty-fleet branch: when the fleet has 0
      lessons AND 0 failure modes AND 0 operator
      handle set, the sitemap still emits the
      fixed pages (`/pulse`, `/receipts`,
      `/calculator`, `/lessons-public/`,
      `/year/<latest>`) - even if the underlying
      data is sparse. Per LESSONS 2026-06-13 the
      empty-fleet gate is NOT applied (an
      empty fleet still has the fixed-page
      surfaces; the helper just doesn't add the
      dynamic rows). Test: seed an empty DB;
      assert `urls.length >= 5` (the fixed
      pages).

- [ ] Rate-limit prefix: add
      `path.startsWith("/sitemap.xml") ||
      path.startsWith("/robots.txt") ||
      path.startsWith("/lessons-public/feed.xml")`
      to the `isRateLimitedPath` OR chain in
      `src/rate_limit.ts`. PRODUCER-VS-SPEC NOTE:
      grep the existing prefix list and ADD the
      three new exact-match prefixes alongside
      `/lessons-public/` (which already covers
      the feed.xml as a side-effect, but
      explicit is clearer per the 0058 / 0064
      precedent). Test: hit `/sitemap.xml` 61
      times from a simulated remote IP; assert
      the 61st returns 429.

- [ ] Cache + invalidation: the sitemap payload
      is memo-cached for 5 minutes keyed by the
      payload's `(publicHost, ingestWatermark)`
      tuple. Per LESSONS 2026-06-07 the
      invalidation tuple uses `(MAX(pr.
      fetched_at), COUNT(*) FROM pr WHERE
      is_agent=1)` AND `(MAX(lesson_credit.
      created_at), COUNT(*) FROM lesson_credit)`.
      Hook on
      `globalThis.__fleet_sitemap_invalidate__`
      registered from `src/server.ts` on module
      load per LESSONS 2026-06-05. Test: render
      the sitemap, insert a new lesson_credit
      row, assert the next render includes the
      new lesson's slug within the next
      invalidation tick.

- [ ] Static-grep ordering assertion: per
      LESSONS 2026-06-15 the test that asserts
      "each new public route mounted BEFORE
      `/api/` auth gate" anchors on the EXACT
      statement shape `if (path.startsWith
      ("/api/"))`. Test: load `src/server.ts`
      source; assert
      `indexOf('GET /sitemap.xml')` <
      `indexOf('if (path.startsWith("/api/"))')`,
      and same for `/robots.txt` and
      `/lessons-public/feed.xml`.

- [ ] tsc --noEmit clean. No new runtime deps -
      lean on `node:http` for the response,
      string templating for the XML / Atom / text
      bodies, the existing `lessonsPublicArchive`
      / `fleetFailureModes` / `lessonLineage
      Payload` payload helpers. No shell-string
      composition. No JSON-shape break to
      `/api/...` routes. No schema migration -
      the sitemap is derived entirely from
      existing tables. Per LESSONS 2026-06-13
      the helper does NOT introduce a new
      `from "./lessons.ts"` import in views.ts;
      reuse the existing private inline
      `anonymiseExcerpt`. Per LESSONS 2026-06-11
      character-window source greps - the new
      helper's leading comment block uses PLAIN
      PROSE for sibling-helper-grep-vulnerable
      identifiers. Per LESSONS 2026-06-15
      static "route mounted before /api/" greps
      anchor on the EXACT `if (path.startsWith
      ("/api/"))` shape. Per CROSS_LESSONS
      2026-06-15 (digitalcraft) any regex over
      the rendered XML attribute lists uses
      `[^>]*` NOT `[^/>]`.

## Out of scope

- A FAVICON / `humans.txt` surface. Adjacent
  but tangential; future ticket if demanded.
- A NEWS sitemap (the Google-News-specific
  format). The standard Sitemap 0.9 is enough
  for organic search.
- A VIDEO / IMAGE sitemap extension. The
  fleet has no video; OG images are already
  per-page so no separate image sitemap is
  needed.
- A `sitemap-index.xml` (for fleets with
  > 50000 URLs). v1 ships a single
  `sitemap.xml`. A future ticket can shard if
  a real operator hits the 50000-URL ceiling.
- A SUBMIT-TO-GOOGLE / Bing API integration.
  The operator submits the URL once via Search
  Console manually; auto-submission requires
  vendor API keys we won't add.
- A NOFOLLOW / robots `<meta>` injection on
  the loopback portal pages. The loopback
  pages are bind-loopback and require a token -
  no crawler reaches them anyway.
- A FEED for /failures/ or /pulse/. The
  v1 surface ships ONE feed for
  /lessons-public/ because lessons are the
  most-frequently-updated content type. A
  future ticket could add per-surface feeds
  if demand justifies the surface multiplication.
- AN AUTO-INDEX OF /og/ AND /embed/ surfaces in
  the sitemap. Those are auxiliary - the OG
  card is reached from its parent page; the
  embed is meant to be iframed. Indexing them
  directly would dilute the long-tail signal.
- A RICH-RESULTS / JSON-LD layer on the
  HTML pages. Per the cross-fleet digitalcraft
  rules (CROSS_LESSONS 2026-05-30) JSON-LD
  predicates and "exactly one of type" tests
  are sibling-coupled - adding @graph / Article /
  TechArticle JSON-LD to each public page is its
  own ticket family.

## Engineering notes

- `src/views.ts` - new helper
  `fleetSitemapPayload(db, cfg, now)` AND
  `renderSitemapXml(payload)` AND
  `renderRobotsTxt(payload)` AND
  `renderLessonsFeedAtom(payload)` AND
  `_renderSitemapForTests(payload, opts)`,
  `_renderRobotsForTests(payload, opts)`,
  `_renderFeedForTests(payload, opts)`. Per
  LESSONS 2026-06-13 the helpers live INSIDE
  `src/views.ts` (no new module - the helpers
  consume the existing public-payload helpers
  one-way; no import-cycle risk). Reuse the
  existing private inline `anonymiseExcerpt`
  per LESSONS 2026-06-13.
- `src/server.ts` - new public route handlers
  `GET /sitemap.xml`, `GET /robots.txt`, `GET
  /lessons-public/feed.xml`. Mount each BEFORE
  the `/api/` auth gate per LESSONS 2026-06-15
  (static-grep ordering anchor is the EXACT
  `if (path.startsWith("/api/"))` shape). The
  routes share the same memo cache (per-route
  cache layer keyed by payload tuple) and
  register
  `globalThis.__fleet_sitemap_invalidate__` per
  LESSONS 2026-06-05.
- `src/rate_limit.ts` - add three new
  prefix matches to the `isRateLimitedPath` OR
  chain. PRODUCER-VS-SPEC NOTE: grep the
  existing prefix list and confirm
  `/lessons-public/` covers `feed.xml` as a
  prefix match (it should) but ADD the
  `/sitemap.xml` and `/robots.txt` exact-match
  prefixes alongside.
- `tests/public-sitemap-rss.test.ts` (NEW) -
  one `test(...)` per AC checkbox above. Per
  LESSONS 2026-05-29 every test pins `now` and
  seeds timestamps off the same anchor. Per
  LESSONS 2026-06-11 the publicHost-unset
  branch uses the renderer-direct seam, NOT
  cwd config mutation. Per LESSONS 2026-06-19
  any test that needs `loadConfig()` with a
  `operator.publicHost` set runs the parser
  in a subprocess pinned to a tmpdir cwd via
  `spawnSync` - never writes to the test
  runner's shared cwd. Per CROSS_LESSONS
  2026-06-15 (digitalcraft) any regex over
  the feed's tag attributes uses `[^>]*` NOT
  `[^/>]`.
- `README.md` - one new subsection "Cold
  discovery: sitemap, robots, RSS" under the
  public surfaces family documents the three
  new routes and the publicHost config field.
- Schema migration: NO. The sitemap / robots /
  feed are derived entirely from existing
  tables (`pr`, `lesson_credit`,
  `lessons_public_archive` / equivalent).
- No new runtime deps. Pairs with 0054 / 0041
  / 0051 / 0057 / 0058 / 0065 / 0068 / 0069 /
  0050 / 0061 / 0064. Per the cross-fleet
  digitalcraft 2026-05-22 lesson on
  mirror-source single-source-of-truth for
  sitemap lastmod, the lastmod stays tied to
  the content's MAX timestamp (NOT the
  sitemap-render timestamp) so Google's crawl
  budget targets fresh pages.

## Implementation log

(Appended by the implementation-dev agent during execution.)
