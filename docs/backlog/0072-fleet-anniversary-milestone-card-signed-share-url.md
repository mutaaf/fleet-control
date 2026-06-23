---
id: 0072
title: Fleet anniversary milestone card and signed share URL - a single home-page card surfaces "<N> year(s) ago today you ran your first agent" on the install-date anniversary plus 100-PR / 500-PR / 1000-PR thresholds with a one-tap share button minting a /share/anniversary/<token> page that frames the operator's accumulated history as a milestone moment only the local SQLite can author
status: in-progress
priority: P1
area: portal
created: 2026-06-23
owner: gtm-innovation
---

## User story

As a fleet operator who installed fleet-control 12 months ago to the day,
who would have LOVED to see a single home-page card this morning reading
"1 year ago today you ran your first agent - 247 features shipped since,
~83 hours saved, 11 lessons your fleet still uses" with a one-tap "share
the moment" button minting a signed `/share/anniversary/<token>` URL I
could paste into Slack/Bluesky/LinkedIn within 5 seconds of seeing the
card, but who today gets NOTHING on this anniversary (0033 yesterday-
glance, 0037 Friday wrap, 0038 Monday catch-up, 0050 year-in-review, 0062
monthly retro, 0059 biggest-surprise all fire on temporal patterns that
ignore the operator's personal install timeline), I want a single
home-page card that lights up ONLY on milestone moments (the install-date
anniversary AND each crossing of 100/500/1000 lifetime merged-agent-PRs)
plus a signed shareable URL rendering that same milestone as a public
artifact a partner/peer/recruiter can open without an account, so that the
operator who has been compounding a relationship with their autonomous
fleet for a year (or 500 PRs) gets the SINGLE day-of-year reflection
ritual they would not have written for themselves and the share artifact
is the kind of "look what compounded" post my honest network actually
clicks - turning a quiet personal milestone the operator might otherwise
miss into both an internal reflection moment AND a public moat artifact
the fleet's accumulated history alone makes possible.

## Why now (four lenses)

### Product Owner

0033 / 0037 / 0038 / 0059 / 0062 ship daily / weekly / monthly cards.
0050 ships the annual /year/<YYYY> page. EVERY existing rhythm card
fires on a CALENDAR pattern (yesterday, Friday, Monday, end-of-month,
end-of-year). NOTHING fires on the operator's PERSONAL TIMELINE - the
1-year anniversary of their install date, the day they crossed 100
merged agent PRs, the day they crossed 500 lifetime ships. These are
the moments any human running a long-running personal project actually
reflects on; the calendar-shaped cards miss them by definition.

The smallest meaningful unit of value: ONE new helper +
ONE conditional home-page card + ONE new public share kind +
ONE new public route.

1. **Detect the milestone** (the signal): a new helper
   `fleetAnniversaryMoment(db, cfg, now)` in `src/views.ts`
   returns `{ kind: 'install_year' | 'pr_100' | 'pr_500' |
   'pr_1000' | 'none', anniversaryDate: string, years:
   number, lifetimePrs: number, lifetimeHoursSaved: number,
   topLessonsStillCited: number, asOf: string, version: 1 }`.
   The install date comes from a NEW row in
   `operator_install_milestones(kind TEXT, recorded_at TEXT)`
   where the `kind = 'install_date'` row is written ONCE on
   the first daemon tick that sees a non-empty DB (per
   LESSONS 2026-06-05 the writer is the existing
   daemon-tick path - PRODUCER-VS-SPEC NOTE: grep
   `src/daemon.ts` for the existing tick-helper shape and
   mirror the call). The 100/500/1000 PR thresholds are
   re-evaluated against the `pr` table's count where
   `is_agent = 1 AND state = 'MERGED'` per LESSONS 2026-06-05
   ("state = 'open'" lower-case) AND 2026-06-07 (the `pr`
   table has no surrogate id; cache invalidation uses
   `(MAX(fetched_at), COUNT(*))`).

2. **The card** (the home-page surface): the existing home
   handler grows ONE NEW conditional card rendered ONLY when
   `fleetAnniversaryMoment` returns kind !== 'none' AND the
   operator has not dismissed this exact milestone (per the
   existing `inbox_dismissal(kind, project_slug,
   payload_id)` PK per LESSONS 2026-05-28 - PRODUCER-VS-SPEC
   NOTE: grep `src/db.ts` for the actual table-name casing).
   The card carries `data-testid="anniversary-card"`, the
   one-line headline ("1 year ago today you ran your first
   agent"), three bullets (total PRs / hours saved / lessons
   still cited), and ONE single button "share the moment".
   The button POSTs `/api/snapshot/anniversary` which mints
   the signed token.

3. **The signed share URL** (the public artifact): a new
   public route `GET /share/anniversary/<token>` resolves
   the existing 0013 / 0066 snapshot infra (new kind:
   `'anniversary'`) and renders a STATIC HTML page with the
   same headline + three bullets + an OG meta block + a
   footer "powered by fleet-control - install yours". Per
   LESSONS 2026-06-15 the route mounts BEFORE the `/api/`
   auth gate (the static-grep ordering anchor is the EXACT
   `if (path.startsWith("/api/"))` shape). Per LESSONS
   2026-06-15 the install-CTA is replaced with a softer
   "powered by fleet-control" caption when
   `quietHoursActiveAnywhere(cfg, now)` is true.

4. **OG card sibling** at `GET /og/share/anniversary/
   <token>.svg` mirrors the 0061 hand-rolled SVG posture:
   1200x630 SVG showing the headline + the three numbers
   + the operator displayName. Per LESSONS 2026-06-12 the
   SVG carries `data-testid="anniversary-og-headline"` and
   the test anchors on the testid NOT a greedy body
   substring (per the same lesson, `data-testid="..."`
   greedy `[^>]+id=` regex would slurp through).

5. **The "thresholds" gate**: the card fires ONLY when ONE
   OF (a) `now` is the calendar anniversary of the install
   date (month and day match), OR (b) the lifetime PR count
   has crossed 100/500/1000 since the last evaluation
   (recorded in `operator_install_milestones`). Both
   evaluations cap at ONCE per kind per year to dedup -
   the install-anniversary `inbox_dismissal` payload_id is
   the YEAR component, the PR-threshold payload_id is the
   threshold value AND year, so a 2-year-fleet that crossed
   500 in year 2 still gets the 500 card distinct from a
   future cross at 1000.

PRODUCER-VS-SPEC NOTE per LESSONS 2026-06-05: the
implementing dev MUST grep `src/views.ts` for the existing
`lessonSavingsRollup` (per 0052) AND the existing
`fleetMonthlyRetro` (per 0062) helper signatures - the
anniversary card REUSES `lessonSavingsRollup`'s
hours-saved math AND the 0062 lifetimePrs aggregate, so
the bullets match the rollup numbers byte-for-byte. Per
LESSONS 2026-06-13 the anniversary helper lives INSIDE
`src/views.ts` alongside `fleetMonthlyRetro` (no new
module - the helper is a pure re-renderer over existing
SQL surfaces). Per LESSONS 2026-06-13 per-candidate
detection fixtures must satisfy the global empty-fleet
gate - the anniversary helper's tests seed enough
trailing PR rows that the lifetimePrs aggregate clears
the "warming up" threshold AND the per-candidate
threshold (e.g. an "install anniversary" test fixture
also seeds 50+ PRs so the lessons-still-cited bullet
isn't zero).

### Stakeholder

Widens the moat on the ACCUMULATED-HISTORY-AS-MILESTONE
axis where no hosted competitor can structurally compete.
The reasoning:

- A hosted observability tool DOES NOT KNOW the
  customer's install date in any meaningful sense - the
  account-creation date is when the customer signed up for
  THIS hosted vendor, not when they started doing
  autonomous-agent work. Fleet-control's install date is
  the date the operator's LOCAL agent work began, which
  is the date that means something to the operator.
- A hosted tool COULD ship a "happy anniversary" email but
  the email lands in a marketing-suppressed inbox and the
  numbers in it are the vendor's numbers (paid PRs, paid
  events) which the operator's autonomous-fleet
  intuition mistrusts. fleet-control's numbers come from
  the operator's OWN runs.jsonl + transcripts + lessons -
  the operator KNOWS the numbers are real.
- The compounding accumulation IS the moat. An operator
  who has been on fleet-control for 12 months has a "247
  PRs, 83 hours, 11 lessons still cited" string that any
  competing tool's profile cannot show even if the same
  operator switches - because the lifetime aggregates
  live in the LOCAL DB the operator has been
  accumulating. Year 2 compounds further on year 1's
  accumulation.

The hosted-competitor structural gap: a hosted tool
COULD ship a calendar anniversary card, but its lifetime
counts only go back to the customer's signup date with
THIS vendor. fleet-control's lifetime counts go back to
the operator's FIRST AGENT, regardless of which kit
version, which laptop, which year - because the local
SQLite carries the whole history.

The "show me" moment worth a screenshot: a Bluesky
post on the operator's anniversary with the rendered OG
card "1 year of fleet-control - 247 PRs, 83 hours saved
back to me, 11 lessons my fleet still cites" alongside
the `/share/anniversary/<token>` URL. Every reader who
clicks lands on the empirical proof of a year of
compounding history.

Per the cross-fleet courtiq lesson "the most clickable
share is the one with NUMBERS that compound across a
long timeline - human readers click '247 PRs over 1
year' at 4-6x the rate of '14 PRs this week' because
the longer timeline IS the credibility"
(CROSS_LESSONS section courtiq Entries 2026-05-21
family on long-timeline-as-credibility), the
anniversary surface is exactly the long-timeline
acquisition node.

Pairs with 0013 (snapshot token infra), 0050 (year-
in-review - the anniversary surface complements the
calendar year), 0062 (monthly retro - shares the
lifetimePrs aggregate), 0052 (lesson-savings ledger -
the hours-saved bullet), 0061 (OG image renderer),
0064 (rate-limit on /share/), 0066 (snapshot.kind
TEXT precedent), 0065 (operator.displayName -
optional embellishment), 0030 (quiet-hours posture).

### User (operator at 9am, looking at the portal)

Three operator scenarios:

1. **The anniversary morning** (the target persona):
   the operator opens the portal at 9am on the calendar
   anniversary of their first agent run, sees ONE NEW
   home-page card "1 year ago today you ran your first
   agent" with the three bullets and the share button.
   They tap "share the moment", the CLI / portal copies
   the URL to clipboard via the existing 0067 share
   plumbing, they paste it into Bluesky. Total time:
   under 10 seconds.

2. **The threshold-crossing morning** (the second
   surface): the operator opens the portal at 9am on
   the morning the autonomous fleet just crossed its
   500th merged PR overnight, sees the card "you just
   crossed 500 merged features shipped autonomously".
   The card is conditionally one of three (100 / 500 /
   1000) - which threshold is the card's headline.

3. **The 364-days-out-of-the-year** (zero impact):
   the operator opens the portal on any other day,
   sees ZERO anniversary card. The helper's daemon-
   tick read is a cheap (MAX(fetched_at), COUNT(*))
   tuple per LESSONS 2026-06-07 plus a date-equality
   check; zero overhead.

Per LESSONS 2026-06-11 the renderer-direct seam
`_renderAnniversaryCardForTests(payload, opts)`
exercises the install-year / pr_100 / pr_500 /
pr_1000 / none / quiet-hours branches without cwd
config mutation. The boot-path test exercises the
integration shape (route mounted before /api/,
content-type, OG meta tags).

### Growth

The growth bet: anniversary moments are the SINGLE
HIGHEST-CONVERTING share an operator authors, because
the post itself is a reflection moment the operator's
network reads as authentic (not a marketing post). Per
the cross-fleet courtiq lesson "the highest-converting
share is the one the operator AUTHENTICALLY wanted to
post anyway - removing one friction step on a share
the operator was going to write turns a 1% post into a
60% post; the tool that makes anniversaries visible IS
the tool that captures the share"
(CROSS_LESSONS section courtiq Entries 2026-05-21
family on authentic-share-conversion), the anniversary
card converts at the high end of every share surface
fleet-control has ever shipped.

A second growth surface: SEARCH. The
`/share/anniversary/<token>` page is a public surface
(per 0064 rate-limited), each one carries an OG meta
block + semantic HTML + a footer install link. A
search engine indexing the public URLs lands the
operator's accumulated-fleet narrative in the long
tail for their own name + "autonomous agents". The
compounding indexed footprint pairs with the 0073
sitemap surface (whenever that lands).

A subtle moat property: the anniversary card cannot
be back-filled by a competitor. An operator who
switches to a competitor on day 366 has lost the
"1 year ago today" framing forever - the competitor's
install date is day-0, and the year that mattered is
gone from the new tool's database. Year-of-history
IS the lock-in, and the anniversary card is the
moment that lock-in becomes visible.

Pairs with 0013 (snapshot token), 0050 (year-in-
review - sibling annual surface), 0067 (share CLI -
the operator could also `fleetctl share anniversary`
in a future ticket, out of scope here), 0061 (OG
infra), 0064 (rate-limit).

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] New table `operator_install_milestones(kind TEXT
      PRIMARY KEY, recorded_at TEXT NOT NULL,
      payload_json TEXT NOT NULL)` added to SCHEMA in
      `src/db.ts`. Per LESSONS 2026-05-26 "no backticks
      inside template-literal SQL strings" - the
      identifier stays plain. The `kind` values are the
      4 literals `'install_date'`, `'pr_100'`,
      `'pr_500'`, `'pr_1000'`. The `recorded_at` is the
      ISO timestamp when the kind first fired. The
      `payload_json` is the snapshotted aggregate at
      fire time so a future render can reproduce the
      original moment if needed. Test: open a fresh
      DB; assert the table exists. Insert a row;
      assert SELECT returns it.

- [ ] New helper `fleetAnniversaryMoment(db, cfg, now)`
      in `src/views.ts` returns `{ kind: 'install_year'
      | 'pr_100' | 'pr_500' | 'pr_1000' | 'none',
      anniversaryDate: string, years: number,
      lifetimePrs: number, lifetimeHoursSaved: number,
      topLessonsStillCited: number, asOf: string,
      version: 1 }`. The helper SELECTs
      `recorded_at` from `operator_install_milestones`
      WHERE `kind = 'install_date'`; if no row exists,
      the helper returns `{ kind: 'none', ... }` AND
      registers a `_recordInstallDateIfMissing(db,
      now)` side-effect that writes the row from the
      earliest `pr.fetched_at` per LESSONS 2026-06-05
      ("state = 'open'" lower-case literal). The
      install-year branch fires when
      `now.getMonth() === recordedAt.getMonth() AND
      now.getDate() === recordedAt.getDate() AND
      years >= 1`. The pr_100 / pr_500 / pr_1000
      branches fire when the lifetime PR count crosses
      the threshold AND no prior row of that kind
      exists in `operator_install_milestones`. The
      lifetimeHoursSaved bullet REUSES the existing
      `lessonSavingsRollup` math per LESSONS 2026-06-05
      (PRODUCER-VS-SPEC: grep
      `src/views.ts:lessonSavingsRollup` and reuse the
      hourly-rate read). Test: seed an install_date
      row 365 days before `now`; assert kind ===
      'install_year', years === 1. Re-seed with
      install_date 100 days ago; assert kind === 'none'.
      Seed a fresh DB with 100 merged-agent PRs and
      no install_date row; assert kind === 'pr_100'
      AND the install_date row was written by the
      side-effect. Per LESSONS 2026-06-13 the
      per-candidate fixture seeds 50+ extra PR rows
      beyond the candidate's own threshold so the
      lessons-still-cited bullet isn't zero by
      accident.

- [ ] Dedup gate: when `fleetAnniversaryMoment`
      returns kind !== 'none' AND an existing
      `inbox_dismissal` row exists with `kind =
      'anniversary'` AND `payload_id =
      <kind>:<year>:<threshold>` (e.g.
      `install_year:2026`, `pr_100:2026:100`), the
      home-page card is OMITTED. Per LESSONS
      2026-05-28 the dedup is a SOFT 365-day window
      (NOT a partial UNIQUE on the milestone table) so
      a future year's anniversary still fires. Per
      LESSONS 2026-05-28 PRODUCER-VS-SPEC: grep
      `src/db.ts` for the `inbox_dismissal` table's
      column casing before writing the dismiss
      payload. Test: seed an install_year anniversary
      AND an `inbox_dismissal` row with the
      year-specific payload_id; render the home; assert
      `data-testid="anniversary-card"` ABSENT. Bump
      `now` to the next calendar year's anniversary;
      assert the card is PRESENT again.

- [ ] Home-page card: the existing home handler in
      `src/server.ts` (per the 0062 home card
      precedent) grows ONE NEW conditional render
      block emitting the anniversary card ONLY when
      `fleetAnniversaryMoment(db, cfg, now).kind !==
      'none'` AND the dismissal gate above. The card
      carries `data-testid="anniversary-card"` and
      `data-testid="anniversary-share-button"`. The
      share button POSTs to a new endpoint
      `POST /api/snapshot/anniversary` which mints a
      `kind: 'anniversary'` snapshot row via the
      existing 0013 / 0066 `createSnapshot(db, { name,
      kind, fleetView })` helper AND returns the
      signed URL in the response body
      `{ url: "/share/anniversary/<token>" }`. Test:
      render home with kind = 'pr_100'; assert both
      testids present. POST to the new API endpoint
      with the home as the source; assert 200 + a
      url field matching `/^\/share\/anniversary\/`.

- [ ] New public route `GET /share/anniversary/<token>`
      in `src/server.ts` resolves the signed token via
      the existing `resolveSnapshotToken` AND checks
      `kind === 'anniversary'` per the 0066 dispatcher
      precedent. 404s on invalid / wrong-kind /
      expired / revoked tokens. The route is mounted
      BEFORE the `/api/` auth gate per LESSONS
      2026-06-15 (static-grep anchor is the EXACT `if
      (path.startsWith("/api/"))` shape). Test: mint a
      valid anniversary token; hit the route; assert
      200 + Content-Type `text/html; charset=utf-8` +
      response body contains
      `data-testid="anniversary-share-page"`. Hit with
      a `stakeholder_monthly` token (wrong kind);
      assert 404.

- [ ] OG card sibling `GET /og/share/anniversary/
      <token>.svg` renders 1200x630 SVG with the
      headline + the three numbers + the operator
      displayName (or "your fleet" when
      `cfg.operator?.displayName` is unset). Per
      LESSONS 2026-06-12 the SVG carries
      `data-testid="anniversary-og-headline"` and
      the test anchors on the testid not a body
      substring (per the same lesson, greedy `[^>]+id=`
      regex must be replaced with the testid anchor).
      Content-Type `image/svg+xml`. 404s on invalid
      tokens. Test: hit with a valid token; assert 200
      + the testid + the three numbers present.

- [ ] OG meta tags on the HTML page: `<meta
      property="og:image" content="<host>/og/share/
      anniversary/<token>.svg">` + `<meta name=
      "twitter:card" content="summary_large_image">` +
      `<meta property="og:title">` + `<meta property=
      "og:description">`. The og:image URL uses
      `cfg.operator?.publicHost` per the existing
      0061 / 0065 composition pattern. Test: assert
      all four meta tags present + og:image URL
      shape.

- [ ] Quiet-hours posture: per LESSONS 2026-06-11
      the `_renderAnniversaryCardForTests(payload,
      opts)` renderer-direct seam exercises the
      quiet-hours branch without cwd mutation. When
      `quietHoursActiveAnywhere(cfg, now)` returns
      true on the public `/share/anniversary/<token>`
      page, the footer install CTA is replaced with a
      softer "powered by fleet-control" caption. Test:
      drive `_renderAnniversaryShareForTests` with
      `quietHoursActive: true`; assert
      `data-testid="install-cta"` ABSENT.

- [ ] Rate-limit prefix: the existing `/share/` and
      `/og/` prefixes already match
      `isRateLimitedPath` (from 0013 / 0061 / 0064 -
      PRODUCER-VS-SPEC: grep `src/rate_limit.ts:
      isRateLimitedPath` to confirm the OR chain).
      The new `/share/anniversary/` and `/og/share/
      anniversary/` sub-paths inherit the throttle
      with NO new prefix needed. Test: hit
      `/share/anniversary/<token>` 61 times from a
      simulated remote IP; assert the 61st returns
      429.

- [ ] Cache + invalidation: the
      `fleetAnniversaryMoment` payload is memo-cached
      for 60s keyed by `now.toISOString().slice(0,
      10)` (the date string). Per LESSONS 2026-06-07
      the invalidation tuple uses `(MAX(pr.fetched_at)
      WHERE is_agent=1 AND state='MERGED',
      COUNT(*) FROM pr WHERE is_agent=1 AND
      state='MERGED')` per the same lesson - the `pr`
      table has no surrogate id; the
      (MAX(fetched_at), COUNT(*)) tuple is the
      "fresh merge landed" proxy. Hook on
      `globalThis.__fleet_anniversary_invalidate__`
      registered from `src/server.ts` on module load
      per LESSONS 2026-06-05. Test: render home,
      insert a merged PR that crosses the next
      threshold, assert the next render flips kind to
      `pr_*`.

- [ ] Static-grep ordering assertion: per LESSONS
      2026-06-15 the test that asserts "anniversary
      route mounted BEFORE `/api/` auth gate" anchors
      on the EXACT statement shape `if
      (path.startsWith("/api/"))`, NOT a prose
      comment that names the gate. Test: load
      `src/server.ts` source via fs.readFile;
      `indexOf('GET /share/anniversary/')` <
      `indexOf('if (path.startsWith("/api/"))')`.

- [ ] tsc --noEmit clean. No new runtime deps - lean
      on the existing `createSnapshot`,
      `resolveSnapshotToken`, `lessonSavingsRollup`,
      `quietHoursActiveAnywhere` helpers. No
      shell-string composition. No JSON-shape break -
      the new `POST /api/snapshot/anniversary` route
      is NEW + the new `anniversary` snapshot kind
      extends the existing TEXT column. Schema
      migration: YES, ONE new
      `operator_install_milestones` table added to
      SCHEMA in `src/db.ts`. Per LESSONS 2026-05-26
      "no backticks inside template-literal SQL
      strings" - the CREATE TABLE uses plain
      identifiers. Per LESSONS 2026-06-11
      character-window source greps - the new
      helper's leading comment block uses PLAIN
      PROSE for sibling-helper-grep-vulnerable
      identifiers. Per LESSONS 2026-06-13
      per-candidate fixtures clear the global
      empty-fleet gate.

## Out of scope

- A WEEKLY CALENDAR anniversary card (every Sunday
  morning surfaces "in this week N years ago you
  shipped..."). The signal-to-noise on a weekly
  surface is too thin; the v1 surface fires on the
  install-date day only AND the three PR thresholds.
- A FAMILY OF SIDE-PROJECT anniversaries ("anniversary
  of your first courtiq PR"). Per-project
  anniversaries are noisier than fleet-wide; the
  operator's emotional anchor is the FIRST agent
  run, not the project's first agent run.
- An AUTO-POST share (the card auto-tweets the
  milestone). Auto-share is creepy; the share
  button is operator-triggered.
- A FEDERATED FIND-MY-COHORT surface (the
  "operators who installed the same week as you").
  Requires multi-instance coordination; v1 is
  single-instance.
- A BADGE / TROPHY / GAMIFICATION layer (the operator
  earns a "1-year veteran" badge in their /operator/
  <handle> profile). The bullets ARE the badges; an
  explicit gamification layer feels juvenile.
- AN EMAIL channel (anniversary triggers a fleet-
  generated email to the operator). fleet-control
  has no email infra; v1 is portal + share-URL only.
- A SECOND-PASS REVISIT card (the anniversary card
  re-fires a week later "did you share it?"). Once
  the operator dismisses the card it's gone for the
  year - no nagging.
- A 100/500/1000 ROLLBACK gate (the threshold
  crossing is reversible if the operator rebuilds
  the DB from a backfill). The
  `operator_install_milestones` row is permanent
  once written; a future ticket can add a
  `--reset-milestones` admin if demanded.

## Engineering notes

- `src/db.ts` - add ONE new CREATE TABLE statement
  to the SCHEMA template:
  `CREATE TABLE IF NOT EXISTS
  operator_install_milestones (kind TEXT PRIMARY
  KEY, recorded_at TEXT NOT NULL, payload_json TEXT
  NOT NULL);`. Per LESSONS 2026-05-26 NO backticks;
  plain identifiers. Per the 0066 / 0071 schema-
  extension precedent the new table sits at the END
  of the SCHEMA block with a comment naming the
  ticket id (no backticks in the comment).
- `src/views.ts` - new helpers
  `fleetAnniversaryMoment(db, cfg, now)`,
  `_recordInstallDateIfMissing(db, now)`,
  `renderAnniversaryCard(payload, opts)`,
  `_renderAnniversaryCardForTests(payload, opts)`,
  `renderAnniversarySharePage(payload, opts)`,
  `_renderAnniversaryShareForTests(payload, opts)`,
  `renderAnniversaryOgSvg(payload)`,
  `_renderAnniversaryOgSvgForTests(payload)`. Per
  LESSONS 2026-06-13 the helpers live INSIDE
  `src/views.ts` alongside `fleetMonthlyRetro` (no
  new module - no function-import cycle risk).
  Reuse the existing `lessonSavingsRollup` math per
  LESSONS 2026-06-05.
- `src/server.ts` - extend the home handler with
  the conditional card render. Mount the new
  routes `GET /share/anniversary/<token>` + `GET
  /og/share/anniversary/<token>.svg` BEFORE the
  `/api/` auth gate alongside the existing
  `/share/` family per LESSONS 2026-06-15 (the
  static-grep ordering anchor is the EXACT `if
  (path.startsWith("/api/"))` shape). Add the new
  `POST /api/snapshot/anniversary` endpoint
  inside the authenticated `/api/` block. Register
  `globalThis.__fleet_anniversary_invalidate__` on
  module load per LESSONS 2026-06-05; consume it
  lazily from `runIngestPass` after the COMMIT
  (so a freshly-merged PR busts the cache).
- `src/snapshot.ts` (or `src/snapshots.ts` -
  PRODUCER-VS-SPEC NOTE: grep the existing
  module path; ticket 0067 says `src/snapshot.ts`,
  earlier tickets say `src/snapshots.ts`; reuse
  whichever the producer uses) - the new
  `anniversary` kind extends the existing TEXT
  column with NO CHECK per the 0066 precedent.
  NO new SQL surface needed.
- `src/rate_limit.ts` - the existing `/share/`
  and `/og/` prefixes already cover the new
  routes. CONFIRM (PRODUCER-VS-SPEC: grep) - if
  somehow they don't, add the new prefixes
  alongside.
- `tests/fleet-anniversary.test.ts` (NEW) - one
  `test(...)` per AC checkbox above. Per LESSONS
  2026-05-29 every test pins `now` and seeds
  timestamps off the same anchor. Per LESSONS
  2026-06-11 branch tests use the renderer-
  direct seam, NOT cwd config mutation. Per
  LESSONS 2026-06-13 every per-candidate fixture
  ALSO seeds enough trailing PR rows that the
  lessons-still-cited bullet isn't accidentally
  zero. Per LESSONS 2026-06-19 any test that
  needs `loadConfig()` with a non-default
  `operator.displayName` runs the parser in a
  subprocess pinned to a tmpdir cwd via
  `spawnSync`.
- `tests/db.test.ts` (existing) - extend with
  one assertion that the new
  `operator_install_milestones` table exists in
  a fresh DB.
- `README.md` - one new subsection "Anniversary
  moments" under the home-card family documents
  the four kinds (install_year, pr_100, pr_500,
  pr_1000) and the share-URL workflow.
- Schema migration: YES, ONE new
  `operator_install_milestones` table added to
  the SCHEMA in `src/db.ts`. Per the 0066 / 0071
  precedent the new table sits at the END of the
  SCHEMA block.
- No new runtime deps. Pairs with 0013 (snapshot
  token), 0050 (year-in-review), 0062 (monthly
  retro), 0052 (lesson-savings), 0061 (OG infra),
  0064 (rate-limit), 0066 (snapshot.kind
  precedent), 0067 (share CLI - future sibling),
  0030 (quiet hours), 0065 (operator
  displayName).

## Implementation log

- 2026-06-23 (implementation-dev) — picked up ticket. Plan:
  - Add `operator_install_milestones` table to `src/db.ts` SCHEMA.
  - Add `fleetAnniversaryMoment(db, cfg, now)` helper + renderer-direct
    seam in `src/views.ts` alongside the 0066 stakeholder helpers
    (per LESSONS 2026-06-13 no new module - lives inside views.ts).
  - Reuse `lessonSavingsRollup` math for hours-saved, query `pr` table
    with `is_agent = 1 AND state = 'MERGED'` (LESSONS 2026-06-05 the
    schema casing here is upper-case MERGED for is_agent=1 ingest path).
  - PRODUCER-VS-SPEC reconciliation: the existing stakeholder helper
    uses `state = 'MERGED'` for merged-agent-PR counts (see
    `src/views.ts:countActiveProjectsInMonth`); the new
    fleetAnniversaryMoment helper matches that producer literal.
  - Mount new public routes `/share/anniversary/<token>` and
    `/og/share/anniversary/<token>.svg` BEFORE the
    `if (path.startsWith("/api/"))` gate alongside the existing
    `/share/stakeholder/` route. Add `POST /api/snapshot/anniversary`
    inside the authenticated `/api/` block.
  - Cache the helper for 60s with the LESSONS 2026-06-07 (MAX(fetched_at),
    COUNT(*)) tuple; register `globalThis.__fleet_anniversary_invalidate__`.
  - Tests live in `tests/fleet-anniversary.test.ts` and follow the
    `tests/stakeholder-summary.test.ts` shape (renderer-direct seam +
    boot-path integration + static-grep ordering).

