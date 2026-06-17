---
id: 0065
title: Public operator-attributed profile page - one stable signed URL the operator pastes into a CV / LinkedIn / portfolio so each share converts cold readers into fleet-control prospects
status: groomed
priority: P1
area: portal
created: 2026-06-17
owner: gtm-innovation
---

## User story

As a fleet operator who has been running fleet-control for 6+ months and
now has 60+ shipped tickets, 150+ authored lessons, and 4 active projects
to my name, who already shares /pulse, /receipts, and /calculator URLs in
casual conversation but has nowhere to point a recruiter / a peer / a
LinkedIn audience that says "this is who I am AS an operator of an
autonomous agent fleet", I want a single stable signed URL
(`/operator/<handle>`) that renders a tasteful one-page portfolio:
handle, headline ("running an autonomous agent fleet since 2025-11"),
career-shaped totals (PRs shipped, lessons authored, projects active,
months running), the three most recent shipped PR titles (anonymised or
attributed at the operator's choice), the three most-cited cross-fleet
lessons, and a footer "powered by fleet-control - install yours at
<github-url>", so that pasting the URL into my LinkedIn bio or a CV
sidebar turns every reader into a high-intent fleet-control impression
without exposing repo names, ticket internals, or any control surface.

## Why now (four lenses)

### Product Owner

Every existing public surface answers a NUMBER-shaped question - /pulse
shows the week, /receipts shows the month, /calculator projects a
generic value claim, /lessons-public surfaces an anonymised lesson,
/failures/<sig> surfaces a failure mode, /year/<YYYY> caps the year.
None of them answer the OPERATOR-IDENTITY question: "who is the human
running this fleet, and what have they accomplished?" Today the
operator who wants to brag pastes a /pulse screenshot AND a /receipts
screenshot AND a sentence of their own prose - three surfaces,
maintained manually, drifting out of date the moment the next week
ships.

The smallest meaningful unit of value: ONE new public route
`/operator/<handle>` that renders the operator's attributable
portfolio in a single static-as-of-now HTML page. The handle is
operator-chosen (`fleet-control.config.json` gains an optional
`operator: { handle, displayName, headline, sinceDate, attribution }`
field) and ONLY when the operator explicitly opts in (handle present)
does the route 200; otherwise it 404s. The page renders:

1. **Header**: handle, displayName, headline, "running an autonomous
   agent fleet since <sinceDate>" - all operator-supplied strings.
2. **Career totals (4 stat blocks)**: total PRs shipped (lifetime
   MERGED is_agent count from `pr`), total lessons authored
   (count from cross-fleet lessons rollup per 0036), projects
   active right now (count from `project` with no `project_pause`
   row), months running (current month minus sinceDate).
3. **"Recent ships" (3 cards)**: the three most recent merged
   agent PRs. Operator's `attribution` flag controls rendering:
   `'anonymised'` (default) shows "shipped a feature in <project
   alias>" with a generic alias; `'attributed'` shows the real PR
   title and project slug. The operator OWNS this trade-off - they
   may want to attribute by name on a CV but anonymise on a public
   profile.
4. **"Top 3 cited lessons"**: the three lessons with the highest
   heal-credit attribution per 0042 / 0052 (lesson-pays-for-itself).
   Anonymised body excerpt per 0057's existing `anonymiseLessonBody`
   surface (re-use, do NOT duplicate per LESSONS 2026-06-13 on
   inline-vs-shared-helper trade-offs).
5. **Footer**: "powered by fleet-control - install yours at
   <github-url>" with the existing OG share posture (per 0061 the
   page exposes `<meta property="og:image" content="/og/operator/
   <handle>.svg">` so a LinkedIn paste auto-renders the card).
6. **OG card sibling** at `/og/operator/<handle>.svg` (NEW) -
   1200x630 hand-rolled SVG that mirrors the four career-totals
   stat blocks plus the handle. Same hand-rolled posture as 0061's
   three OG cards.

PRODUCER-VS-SPEC NOTE per LESSONS 2026-06-05: the implementing dev
MUST grep `src/ingest/prs.ts` for the literal value of `pr.state`
for MERGED rows (the existing literal is `'MERGED'` uppercase per
0050 reconciliation in src/ingest/prs.ts:235); the SELECT for
career-total ship count MUST match that casing. Per LESSONS
2026-06-07 the lifetime aggregate has no surrogate id on `pr` so
the cache invalidation tuple is `(MAX(pr.fetched_at), COUNT(*)
FROM pr)`. Per LESSONS 2026-06-15 on "first month meaningfully
crossed" the months-running counter uses the operator-supplied
sinceDate, NOT a derived "first PR ever" anchor (which would be
fragile to a fresh-install operator with imported history).

### Stakeholder

Widens the moat on the OPERATOR-IDENTITY axis where no existing
surface invests. 0013 (signed snapshots) is per-fleet, single-use,
expires in 24h. 0050 (year-in-review) is per-YEAR, freshly rendered
each visit. 0041 (receipts) is per-MONTH. None are PERSON-attributed
and PERSISTENT. The operator profile is the first surface that lets
an external reader say "I want THIS person to run my agent fleet" -
not "I want THIS tool".

The hosted-competitor structural gap: every SaaS observability tool
in this space has user accounts but no notion of "personal
portfolio of agent work" because they don't have the longitudinal
cross-project SQLite the local kit accumulates. A hosted tool
showing "your fleet's lifetime PRs" requires the operator to have
been on the hosted tool for the whole lifetime; fleet-control
shows it from day one because the database is local and reads
every transcript / runs.jsonl historically. THIS is the moat
property - lifetime aggregates the hosted tools structurally
cannot match.

Per the cross-fleet courtiq lesson "the operator's personal
portfolio is the strongest acquisition surface a single-user tool
can ship, because every share is signed by someone the reader
already trusts" (CROSS_LESSONS section courtiq Entries 2026-05-21
family on attribution-as-acquisition), the operator profile
collapses three pieces of friction into one URL:
  (1) the operator wants to brag but doesn't want to maintain a
      separate portfolio site;
  (2) the recruiter / peer wants to verify what an operator's
      autonomous-agent claim actually delivered;
  (3) fleet-control wants every share to seed an install.

The "show me" moment worth a screenshot is the LinkedIn bio
edit: "fleet operator since 2025-11 - see what my agents shipped:
fleet-control.example.com/operator/mutaaf". The bio edit IS the
impression, and the click-through IS the acquisition.

Pairs with 0050 (year-in-review - the profile links to the most
recent /year/<YYYY> for deeper detail), 0041 (receipts - the
profile links to /receipts for monthly context), 0061 (OG image
infra - the operator OG card reuses the hand-rolled SVG posture),
0064 (rate-limit middleware - the new route inherits the public-
surface throttle by virtue of NOT being under `/api/`, so it
SHOULD be added to the rate-limit prefix list per 0064's
groundwork).

### User (operator at 9am, looking at the portal)

Three operator scenarios:

1. **First-time setup** (one-time, < 60 seconds): the operator
   edits `fleet-control.config.json` to add `operator: { handle:
   "mutaaf", displayName: "Mutaaf", headline: "running an agent
   fleet on personal projects", sinceDate: "2025-11-01" }`.
   Restarts the server. Visits `/operator/mutaaf` - sees their
   own portfolio. Copies the URL into LinkedIn. Done.

2. **Daily glance** (zero impact): the operator's portal home
   page is UNCHANGED - the profile page is OPT-IN; the home
   page does NOT surface a new card unless the operator
   navigates to `/operator/<handle>` deliberately. The
   existing home page rhythm is sacred (0033, 0037, 0038,
   0055, 0059, 0062 already compete for that real estate).

3. **Share moment** (the high-leverage moment): operator
   ships a feature, opens LinkedIn to write a post, pastes
   `<host>/operator/<handle>` as the link. LinkedIn's
   crawler hits the page, scrapes the `og:image` meta, and
   auto-renders the 1200x630 card. The reader sees a
   tasteful portfolio card in their feed; clicks through;
   lands on the profile page; sees four career stats + 3
   ship cards + 3 lesson excerpts + the install link.

Per LESSONS 2026-06-11 "startServer() tests that mutate
`fleet-control.config.json` race against parallel test
files; expose a renderer-direct seam for branch tests" - the
profile renderer MUST be exercised via a renderer-direct seam
`_renderOperatorProfileForTests(payload, opts)` so the
`attribution: 'anonymised' | 'attributed'` branch is testable
without cwd config mutation. The boot-path test stays
valuable for the integration shape (route mounted, 404 when
no operator config, content-type, OG meta tags present) but
the branches drive the seam.

Per LESSONS 2026-06-12 on greedy `[^>]+id=` regex - any test
that scrapes the handle out of the rendered HTML MUST anchor
on `data-testid="operator-profile-handle"` and use a
non-greedy quantifier, NOT a body substring match.

### Growth

The growth bet: every operator profile page is a HIGH-INTENT
acquisition surface because the reader is reading it BECAUSE the
operator pasted it - the reader already trusts the operator and is
ready to evaluate the tool. Per the cross-fleet courtiq lesson
"the prospect's first click into a public surface should answer
'is this credible' in 3 seconds AND 'how do I get this' in 6
seconds" (CROSS_LESSONS section courtiq Entries 2026-05-21
family on conversion friction), the profile page does both:

  - Credibility: 4 career totals (lifetime PRs shipped, lessons
    authored, projects active, months running) - all numbers, all
    derived from real telemetry, all impossible to fake in a
    screenshot.
  - Conversion: footer line "install yours at <github-url>" is
    the single CTA. Per LESSONS 2026-06-11 quiet-hours
    suppression - if the operator has quietHours active when the
    page is RENDERED, the install CTA is suppressed per the
    existing 0054 pulse posture (a profile rendered at 2am the
    visitor's time still shows numbers but no actionable CTA).

The viral surface compounds: every LinkedIn impression of an
operator profile is an impression of fleet-control. The
operator does the marketing labour for free, and the marketing
artifact (the profile page) updates itself with every PR the
fleet ships - the operator never has to maintain it.

Pairs with 0061 (OG image infra), 0050 (year-in-review - the
profile links out), 0041 (receipts - sibling monthly surface),
0064 (rate-limit middleware - the new route's IP throttle).

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE per
LESSONS 2026-06-05: the implementing dev MUST grep
`src/ingest/prs.ts` for the merged-PR state literal (`'MERGED'`
uppercase per 0050 reconciliation) AND grep `src/views.ts` for
the existing helper that aggregates lifetime PR counts (per 0050
year-in-review - reuse the SELECT, do NOT re-author). Per LESSONS
2026-06-13 the operator profile MUST NOT introduce a
`from "./views.ts"` import on a module `views.ts` already imports
- the new helper lives INSIDE `src/views.ts` alongside the year-
in-review sibling, NOT in a new `src/operator.ts` module that
would create a cycle.

- [ ] New helper `operatorProfilePayload(db, config, now)` in
      `src/views.ts` returns `{ handle, displayName, headline,
      sinceDate, totals: { lifetimePrsShipped, lessonsAuthored,
      projectsActive, monthsRunning }, recentShips: [{ title,
      projectAlias, mergedAt }], topLessons: [{ slugAnon,
      excerpt, healCredits, lastCreditedAt }], attribution:
      "anonymised" | "attributed", quietHoursActive: boolean,
      asOf, version: 1 }`. The `lifetimePrsShipped` SELECT uses
      `WHERE state = 'MERGED' AND is_agent = 1` matching producer
      casing. The `monthsRunning` math anchors on the operator-
      supplied `sinceDate`, NOT a derived "first PR ever"; the
      helper is pure on `(db, config, now)` per LESSONS 2026-05-
      29 (now passes through, never `new Date()` inside the
      helper). Test: seed 3 merged PRs across 2 projects + 5
      lessons (2 with heal credits per 0042 schema) + config
      with `operator: { handle: "mutaaf", sinceDate:
      "2025-11-01" }` + `now: "2026-06-17T09:00:00Z"`; assert
      the returned payload's totals match the seed AND
      `monthsRunning === 7`.

- [ ] New route `GET /operator/<handle>` in `src/server.ts`
      renders the profile page when `config.operator?.handle ===
      handle` (case-sensitive) and 404s otherwise. The route is
      PUBLIC (no auth gate) and inherits the 0064 rate-limit
      middleware by being added to the helper's rate-limited
      path prefix list (the same `/share/` / `/embed/` / `/og/`
      family). PRODUCER-VS-SPEC NOTE: grep
      `src/rate_limit.ts:isRateLimitedPath` for the existing
      prefix list and ADD `/operator/` per the 0064 surface
      contract. Test: hit `/operator/mutaaf` with the seeded
      config - assert 200 + `Content-Type: text/html;
      charset=utf-8` + the rendered HTML contains
      `data-testid="operator-profile-handle"` with value
      "mutaaf". Hit `/operator/wronghandle` - assert 404. Hit
      `/operator/mutaaf` 61 times from a simulated remote IP -
      assert the 61st returns 429 per the 0064 rate-limit.

- [ ] Attribution branch: when `operator.attribution ===
      'anonymised'` (default), `recentShips[i].title` is the
      string `"shipped a feature"` and `recentShips[i].
      projectAlias` is the form `"project-a"` / `"project-b"`
      (per 0013's anonymisation discipline). When
      `attribution === 'attributed'`, `recentShips[i].title`
      is the literal `pr.title` AND `projectAlias` is the
      real `project.slug`. Per LESSONS 2026-06-11 expose
      `_renderOperatorProfileForTests(payload, opts)` and
      drive both branches directly. Test: render with the
      same seed payload under each attribution mode; assert
      the anonymised render contains "project-a" and the
      attributed render contains the real seed slug.

- [ ] OG image sibling at `GET /og/operator/<handle>.svg`
      mirrors the 0061 hand-rolled SVG posture. 1200x630
      dimension. Four stat blocks. Handle + headline.
      Footer with the install hint. Content-Type:
      `image/svg+xml`. The route 404s when no `operator`
      config is present OR the handle doesn't match. Per
      LESSONS 2026-06-12 the SVG carries `data-testid=
      "operator-og-handle"` and the test anchors on the
      testid, NOT a body substring. Test: hit
      `/og/operator/mutaaf.svg` with seed config - assert
      200 + content-type + the SVG contains the testid +
      the lifetime PR count rendered as a `<text>`
      element.

- [ ] The rendered HTML head carries `<meta property=
      "og:image" content="<host>/og/operator/<handle>.svg">`
      AND `<meta name="twitter:card" content="summary_large_
      image">` AND `<meta property="og:title">` AND
      `<meta property="og:description">`. The og:image URL
      uses the `host` config field (per the existing 0061
      composition) so LinkedIn's crawler resolves an
      absolute URL. Test: hit `/operator/mutaaf` - assert
      the response body contains all four meta tags AND the
      og:image URL is absolute.

- [ ] Empty-state branch: when the operator has shipped < 3
      PRs total OR authored < 1 lesson, the `recentShips`
      array contains fewer than 3 entries (no padding) AND
      `topLessons` may be empty. The page still renders a
      tasteful "early-stage operator" framing (per LESSONS
      2026-06-15 on first-meaningful-month pivot - use a
      threshold-shaped operator-facing copy: "your fleet is
      still warming up - check back after your first 3
      ships"). Test: seed config with `operator` but seed 0
      PRs - assert the rendered page contains `data-
      testid="operator-profile-warming-up"` AND no
      `recent-ship` testids.

- [ ] Opt-out gate: when `config.operator?.handle` is
      undefined (the default), the `/operator/*` route and
      the `/og/operator/*` route both 404 for every handle.
      The operator's home portal is UNCHANGED. Test: seed
      config with NO `operator` field - assert `GET
      /operator/anything` returns 404 + assert
      `GET /og/operator/anything.svg` returns 404 + assert
      the home page (`GET /`) renders unchanged (no
      profile-page CTA).

- [ ] Quiet-hours posture: when
      `quietHoursActiveAnywhere(config, now)` returns true
      (per 0054 / 0030 helpers - PRODUCER-VS-SPEC NOTE:
      grep `src/quiet_hours.ts` for the existing helper
      name), the page renders normally BUT the footer
      "install yours" CTA is replaced with a softer "fleet
      operator since <sinceDate>" caption (no CTA, no
      external link). Per LESSONS 2026-06-11 drive the
      branch via `_renderOperatorProfileForTests(payload,
      { quietHoursActive: true })`, NOT via cwd config
      mutation. Test: render with `quietHoursActive: true`;
      assert the response does NOT contain
      `data-testid="install-cta"`.

- [ ] Cache + invalidation: the profile payload is memo-
      cached for 60 seconds (matching the 0050 / 0054 /
      0061 cadence). The cache key includes the handle.
      Per LESSONS 2026-06-07 the invalidation tuple uses
      `(MAX(pr.fetched_at), COUNT(*) FROM pr,
      MAX(lesson_credit.last_credited_at), COUNT(*) FROM
      lesson_credit)` - no surrogate id on either source.
      Per LESSONS 2026-06-05 the invalidation hook lives
      on `globalThis.__fleet_operator_profile_
      invalidate__` and is registered from `src/server.ts`
      on module load; `runIngestPass` reads it lazily.
      Test: render the profile, advance the seed (insert a
      new merged PR), assert the next render reflects the
      new PR within the next invalidation tick (NOT after
      a full 60s wait).

- [ ] tsc --noEmit clean. No new runtime deps. No shell-
      string composition (no `child_process.exec` shape;
      all SQL via `db.prepare`). The new
      `/api/admin/operator-state` is NET-NEW (no JSON
      shape break to existing routes). The `operator`
      config field is OPTIONAL (existing configs work
      unchanged). No schema migration - the profile is
      DERIVED from existing `pr` / `lesson_credit` /
      `project` / `project_pause` tables (no new
      writes). Per LESSONS 2026-06-11 character-window
      source greps - the new helper's leading comment
      block uses PLAIN PROSE (no backticks) for any
      identifier a sibling-helper grep window might
      capture. Per LESSONS 2026-06-15 on static "route
      mounted before /api/ auth gate" greps - any
      ordering assertion anchors on the actual `if (`
      statement, NOT a literal substring that could
      appear in a comment.

## Out of scope

- A MULTI-OPERATOR namespace (per-tenant). v1 is single-
  operator (one `operator` config field). The handle is
  globally unique by virtue of being the only one.
- A WRITE surface that lets the operator edit profile
  fields from the portal. v1 is config-file-edited (per
  the zero-dep posture - a portal write surface adds
  authn + audit + race-handling complexity that an
  unattended file edit dodges).
- A FOLLOWERS / SUBSCRIPTIONS mechanic. v1 is a static
  portfolio page; readers click through to install, they
  don't sign up to follow.
- A PROFILE PHOTO / AVATAR. v1 is text-only. A future
  ticket could add a config-file-supplied SVG initial,
  but a profile photo introduces image hosting questions
  the zero-dep posture is hostile to.
- A LIVE-UPDATING widget (the profile auto-refreshes in
  the browser). v1 is static-as-of-cache. A future
  ticket could add a 5-minute meta-refresh.
- AGE / LOCATION / OTHER PERSONAL DETAILS. The operator
  picks what to display via headline / displayName.
  Adding structured demographic fields is friction for
  ~0% lift.
- A FEDERATED "operators you might know" cross-fleet
  surface. Requires a multi-instance posture
  (FLEET_PEERS) that no existing surface has - separate
  ticket if/when needed.

## Engineering notes

- `src/views.ts` - new helper `operatorProfilePayload(db,
  config, now)` alongside the year-in-review / receipts /
  pulse siblings. The helper composes the four career
  totals from existing tables (`pr`, lesson_credit per
  0042 / 0052, `project`, `project_pause`). PRODUCER-VS-
  SPEC NOTE: grep `src/ingest/prs.ts` and `src/views.ts`
  for the existing merged-PR SELECT (`state = 'MERGED'`)
  before authoring the lifetime aggregate. NO new SQL
  shape - the count is `SELECT COUNT(*) FROM pr WHERE
  state = 'MERGED' AND is_agent = 1`.
- `src/views.ts` - new helper
  `_renderOperatorProfileForTests(payload, opts)` exposes
  the attribution + quiet-hours branches directly per
  LESSONS 2026-06-11. NO new helper module - keeping the
  renderer in views.ts avoids the function-import-cycle
  trap per LESSONS 2026-06-13 (multiple modules already
  import views.ts).
- `src/server.ts` - new public routes `GET /operator/
  <handle>` and `GET /og/operator/<handle>.svg`. Mount
  BEFORE the `/api/` auth gate (the routes are public).
  Per LESSONS 2026-06-15 the static-grep ordering
  assertion anchors on `if (path.startsWith("/api/"))`,
  NOT a comment substring. The route handler memo-
  caches the payload for 60s and uses the
  `globalThis.__fleet_operator_profile_invalidate__`
  slot per LESSONS 2026-06-05.
- `src/rate_limit.ts` - add `/operator/` to the rate-
  limited path prefix list. This is the explicit
  reason the 0064 ticket grew an `/og/` and `/share/`
  prefix family - new public routes inherit the
  throttle by extending the helper's prefix list, NOT
  by introducing a parallel limiter.
- `src/config.ts` - new optional `operator: { handle:
  string, displayName?: string, headline?: string,
  sinceDate: string, attribution?: "anonymised" |
  "attributed" }` field. Defaulting pattern matches
  the existing `embedOrigins` / `embedRateLimit`
  field. When the field is omitted, the routes 404.
- `src/lessons.ts` - the existing
  `anonymiseLessonBody` helper is REUSED by the new
  profile renderer (do NOT inline a copy per LESSONS
  2026-06-13 - here the import direction is safe
  because `views.ts` already imports `lessons.ts`
  per the 0055 lesson-of-the-day surface, so adding
  a SECOND usage point inside views.ts is the same
  direction, no cycle introduced).
- `tests/operator-profile.test.ts` (new) - one
  `test(...)` per AC checkbox above. Per LESSONS
  2026-05-29 every test pins `now` and seeds
  timestamps off the same anchor. Per LESSONS
  2026-06-11 the branch tests use the renderer-
  direct seam, NOT cwd config mutation. The boot-
  path test for the integration shape uses the
  empty-roots config + savedConfigText snapshot
  pattern per LESSONS 2026-05-26.
- `web/app.js` - NO new SPA surface (the profile
  page is server-rendered HTML, like /pulse /
  receipts / year-in-review). A future v2 ticket
  could add a portal-side profile editor.
- `README.md` - one new subsection "Operator
  profile" under the public-pages family
  documents the config field, the route, and the
  attribution trade-off. Per the existing 0054 /
  0055 / 0057 README posture.
- Schema migration: NO. The profile is derived
  entirely from existing tables. The `operator`
  config field is in JSON, not SQLite.
- No new runtime deps. Lean on existing helpers
  (anonymiseLessonBody, lessonSavingsRollup,
  fleetWeeklyPulse for the receipt-style stat
  blocks) and hand-rolled SVG for the OG card per
  0061's precedent. Pairs with 0050 (year-in-
  review - links out from the profile), 0041
  (receipts), 0061 (OG infra), 0064 (rate-limit
  protection), 0057 (anonymisation discipline),
  0013 (anonymised slug discipline), 0042 / 0052
  (lesson credit ledger - source for top-lessons
  block).

## Implementation log

(Appended by the implementation-dev agent during execution.)
