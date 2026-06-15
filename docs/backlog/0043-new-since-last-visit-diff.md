---
id: 0043
title: New-since-last-visit diff - mark every home-page item the operator has not yet seen
status: shipped
priority: P1
area: portal
created: 2026-06-07
owner: gtm-innovation
---

## User story

As a fleet operator opening the portal at lunch after a morning of
meetings, I want every home-page item that landed since I last
looked - a newly merged PR, a fresh anomaly, a new ntfy push, a
new inbox row - to carry a subtle "NEW" pip plus a one-line summary
band at the top "3 new since you last looked at 9:14am" - so that I
don't have to mentally diff the page against my memory; the portal
just tells me what I have not yet seen, and clears the pips the
moment I do.

## Why now (four lenses)

### Product Owner
0038 (Monday catch-up) bridges the weekend gap; 0033 (Yesterday)
recaps the previous day; 0017 (inbox) shows everything that needs
attention. NONE of them answer the much more frequent "what changed
since the LAST page render" question - the operator who looks at
the portal at 9am, 11am, 2pm, and 4pm currently re-scans every
section every time because the page has no concept of "last time I
saw this." 0038 already laid the groundwork: every authenticated
`/api/fleet` GET upserts a `home_last_seen_<actor>` row into the
existing `watermark` table. This ticket REUSES that watermark for
every home-page section: each PR card, anomaly row, ntfy event,
inbox row, and merged-PR row is compared against the LAST visit
timestamp; rows newer than that get a pip. The smallest meaningful
unit of value: the operator's mental diff cost - which is
currently O(N) on every visit - collapses to O(NEW). Pure
composition over existing tables; no new schema; tiny SPA-side
state.

### Stakeholder
Widens the moat on retention - specifically the WITHIN-DAY return
visit. 0038 catches the weekend; 0033 catches overnight; the
new-since-last-visit pip catches the intra-day pulse. Every
observability tool faces the same problem (the dashboard rots into
noise the second time you look at it the same day); fleet-control
is uniquely positioned because (a) it already has a single
authenticated session per actor (loopback vs token id) and (b) it
already records the home-page last-seen via 0038. The structural
moat: GitHub-native marks PRs you have not read individually
(across all of GitHub); fleet-control marks them across the FLEET
within your own portal session, which is a different abstraction
and the one the operator's mental model wants. Cheap to ship (one
helper, two SPA hooks), and the retention payoff is huge - every
return visit lands on "new since you looked" rather than the
generic dashboard.

### User (operator at 2pm, returning after the morning)
At the TOP of the home page, BELOW any Monday-catchup or
Friday-wrap card but ABOVE the project grid, a thin banner:

```
3 new since you last looked at 9:14am - [show only new]
```

The "show only new" toggle filters the home page so only sections
with at least one new item are visible (the project grid hides
all-quiet projects). Each individual new item carries a small
"NEW" pip - a colored dot on PR cards, an inline pip on inbox
rows, etc. The pip clears the moment the operator's session has
RENDERED the item (a client-side IntersectionObserver fires the
seen-watermark update once the item enters the viewport, batched
once every 5s). When the operator returns 30 minutes later, ONLY
items that landed in the new 30-minute window carry pips. On phone
the banner collapses to "3 new (9:14am)" with the toggle tap-
target; the pips on cards become a 6px dot at the top-left.

The seen-watermark distinguishes between (a) the operator's last
visit to the HOME PAGE (the 0038 `home_last_seen_<actor>` row)
and (b) the per-section last-seen ("last time the operator
actually looked AT this inbox row"). A new per-actor watermark
key `home_section_seen_<actor>_<section>` is upserted by the SPA
each time a section is viewport-visible for >= 2 seconds. The
fleet-wide banner counts items newer than the global home-last-
seen; the per-item pip uses the per-section watermark. Both
clear within the same session, both persist across browser
restarts (server-side state, not localStorage).

### Growth
The screenshot worth sharing: a phone-screen recording of
fleet-control on a Monday, the operator scrolls past a fresh PR
card with a glowing NEW pip and the pip fades in real time as the
card enters the viewport. The "show me" pitch: "every other
dashboard makes you re-read everything; fleet-control quietly
marks the three things you have not yet seen." That artifact is
more compelling than 0033's daily card (which is a recap) or
0017's inbox (which is a queue) because it changes the BASIC
INTERACTION MODEL of the portal: a return visit lands on what is
NEW, not on what already happened. The kind of subtle
opinionated detail that makes prospective adopters say "wait, it
does that?"

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: when
this spec names a column value literally (`pr.state = 'open' or
'MERGED'`, `outcome = 'shipped'`, etc.), the implementing dev MUST
grep `src/ingest/prs.ts` (line 164) and `src/ingest/runs.ts` for
the producer's actual casing before writing the SELECT. Per
LESSONS 2026-06-05 "groomer prose can disagree with the schema;
the schema wins": the producer is the contract.

- [ ] `src/views.ts` exports `newSinceLastVisit(db, now: Date,
      actorKey: string, opts?: {sections?: Array<"pr_merged" |
      "pr_open" | "anomaly" | "inbox" | "alert">}): {last_seen:
      string | null, total_new: number, by_section: {pr_merged:
      Array<{project_slug: string, pr_number: number, title:
      string, merged_at: string}>, pr_open: Array<{project_slug:
      string, pr_number: number, title: string, created_at:
      string}>, anomaly: Array<{project_slug: string, anomaly_id:
      number, title: string, created_at: string}>, inbox:
      Array<{kind: string, project_slug: string, payload_id:
      string, created_at: string}>, alert: Array<{alert_id:
      number, project_slug: string, type: string, created_at:
      string}>}, generated_at: string}`. Reads
      `home_last_seen_<actor>` from `watermark`; when absent,
      treats `last_seen` as `null` and `total_new` as 0 (a
      first-visit gets no pips - the banner only appears after
      the SECOND visit). For each section, selects rows with
      `created_at > last_seen` AND the section's existing
      visibility filters. Per LESSONS § "node:sqlite's .all()
      needs `as unknown as T[]`", every row narrowing uses the
      double-cast. Test: seed two visits 30 min apart with 2
      merged PRs / 1 anomaly / 1 inbox row landing in between,
      assert the four counts and the items returned; seed one
      visit only, assert `total_new: 0`.
- [ ] `markSectionSeen(db, actorKey: string, section: string,
      itemIds: Array<string>, now: Date): {upserted: number}`
      upserts `home_section_seen_<actor>_<section>` keys into
      `watermark` with the `cursor` column carrying a JSON-
      encoded list of seen item ids (capped at the LAST 200
      ids per section to bound the column size). Returns the
      count of new ids added. Per LESSONS § "no backticks
      inside template-literal SQL strings", identifiers stay
      plain. Test: call twice with overlapping ids, assert the
      union is stored; call with 250 unique ids in one batch,
      assert the cursor caps at 200 most-recent.
- [ ] `GET /api/fleet/new-since-visit` returns the shape from
      AC1. Requires `read` scope. The `actorKey` is derived
      server-side from the request (`loopback` for unauthed
      loopback, or the auth_token id for authed requests) - the
      operator never passes it explicitly. Test: hit without
      auth (non-loopback) -> 401; loopback with no prior visit
      -> 200 with `last_seen: null` and `total_new: 0`;
      loopback with a prior visit + 3 new items -> 200 with
      `total_new: 3`.
- [ ] `POST /api/fleet/section-seen` body `{section: string,
      item_ids: Array<string>}` requires `read` scope. Calls
      `markSectionSeen()` server-side. Returns
      `{upserted: number}`. Test: POST with 5 ids, assert the
      watermark cursor; POST again with 3 overlapping ids,
      assert the watermark cursor union; POST with an unknown
      `section` -> 400.
- [ ] Watermark interaction with 0038: the existing
      `home_last_seen_<actor>` watermark (per 0038) is the
      AUTHORITATIVE last-visit timestamp. This ticket does
      NOT change the 0038 upsert behaviour. When the operator
      visits the home page, 0038's upsert runs FIRST (on the
      `/api/fleet` GET), which means
      `newSinceLastVisit(now-1s)` returns the items that
      landed BEFORE the upsert. The SPA solves this by
      passing an explicit `?since=<previous_last_seen>` param
      on the home-page render so the diff is against the
      PREVIOUS visit's timestamp, not the JUST-UPSERTED one.
      The server fetches the previous value BEFORE the
      0038 upsert and returns it in the `/api/fleet`
      payload as a new top-level `previous_last_seen` field
      (additive on the existing JSON shape - per AGENTS.md
      Hard NO "Never break the JSON shape of an existing
      `/api/...` route", an additive field is permissible).
      Test: seed a prior visit at T-30min, hit
      `/api/fleet`, assert `previous_last_seen: T-30min` in
      the response; hit
      `/api/fleet/new-since-visit?since=T-30min`, assert
      items in [T-30min, now] are returned.
- [ ] Caching: `/api/fleet/new-since-visit` sets
      `Cache-Control: no-store` (the value is per-visit and
      changes the moment ANY new row lands). The handler
      does NOT memoise - cache misses are cheap (the SELECT
      is bounded by `created_at > since` with existing
      indexes; for a fleet of 50 projects the typical
      response is < 20ms). Test: hit the route twice in
      quick succession, assert the response shape is
      consistent; hit it after a new PR lands, assert the
      new PR appears.
- [ ] `web/app.js` renders the banner at the absolute top
      of the home page when `total_new > 0`. Format: "<N>
      new since you last looked at <HH:mm>" with a "show
      only new" toggle button that filters the project grid
      and the open-PR section. The banner uses
      `data-testid="new-since-banner"`. Each new PR card,
      anomaly row, inbox row, and merged-PR row carries a
      pip element with `data-testid="new-pip-<section>-
      <id>"`. The pip element fades out 600ms after the
      `markSectionSeen` POST completes for its id. Per
      LESSONS § "defence-in-depth secret redaction at the
      renderer boundary", every operator-visible string
      (item title, project slug) passes through
      `redactSecrets`. Test: stub `total_new: 3`, assert
      the banner contains "3 new" and the three pips
      exist; stub `total_new: 0`, assert no banner and no
      pips; tap the toggle, assert sections with zero new
      items are hidden.
- [ ] IntersectionObserver hook: when a pipped item is at
      least 50% visible in the viewport for 2000ms, the
      SPA batches its id into a queue and POSTs to
      `/api/fleet/section-seen` every 5 seconds OR on
      page hide (`visibilitychange`), whichever fires
      first. The pip fades out on a successful 200
      response. Per LESSONS § "in-process dedup sets need
      an explicit reset hook for tests", the SPA's
      seen-queue exposes a global `__fleet_seen_queue__`
      reset hook for the headless mobile-portal test
      harness. Test (DOM-level, using the existing
      mobile-portal harness pattern): simulate a card
      coming into viewport, advance 2000ms, assert the id
      is queued; advance 5000ms more, assert the POST
      fires.
- [ ] Mobile: at 375px viewport the banner collapses to
      "<N> new (<HH:mm>)" with the toggle as a chip; the
      per-item pip is a 6px dot at the top-left of each
      card (no text label). No horizontal scroll (per
      0011 conventions). Test: assert via the existing
      mobile-portal text-level CSS contract at 375px and
      600px.
- [ ] Quiet-hours integration: when 0030's
      `quietHoursActive` is `true`, the banner still
      renders (it is a pull surface, not a push) BUT it
      uses muted styling (neutral colour, no animation)
      to match the quiet-hours portal mode 0030
      already establishes. The pips render as outlined
      circles instead of filled dots in quiet hours.
      Test: stub quiet hours active, assert the banner
      has class `quiet-hours-mode`; stub quiet hours
      inactive, assert the class is absent.
- [ ] First-visit case: when `home_last_seen_<actor>` is
      ABSENT (operator's first-ever home visit, or a
      revoked token), the banner does NOT render and no
      pips are emitted. The 0038 upsert STILL writes the
      first watermark so the NEXT visit gets a banner.
      Test: clear the watermark, hit `/api/fleet`,
      assert no banner; hit `/api/fleet` again 1 min
      later with 1 new PR, assert the banner shows "1
      new".
- [ ] Performance: `newSinceLastVisit(db, now, actor)`
      against a fleet of 50 projects with 500 new rows
      since `last_seen` completes in under 30ms (the
      SELECTs are window-bounded). The HTTP route end-
      to-end completes in under 80ms. Per LESSONS §
      "in-process startServer() tests need an empty-
      roots config + run-row seeds", server-boot tests
      plant a tmp `fleet-control.config.json` in cwd
      and restore on cleanup. Test: seed the dataset,
      time both, assert thresholds (skip if
      `process.env.PERF !== "1"`).
- [ ] No new runtime deps. `tsc --noEmit` clean. No
      shell-string composition. The only additive
      change to an existing `/api/...` route is the
      new TOP-LEVEL `previous_last_seen` field on
      `/api/fleet` (per AGENTS.md, additive on
      existing routes is permitted; renaming or
      removing is not). No schema migration - reuses
      the existing `watermark(source, cursor,
      updated_at)` table. Per LESSONS § "no backticks
      inside template-literal SQL strings",
      identifiers stay plain.

## Out of scope

- A per-page "mark all as read" button. The seen
  semantic is automatic (viewport-based) by design;
  a manual mark-all surface would race the
  automatic one and the operator would have two
  inconsistent states.
- Persistent localStorage-side pip state. The
  server is the source of truth - this keeps the
  pip state consistent across devices (open the
  portal on the laptop and the phone shows the
  laptop's seen state).
- Cross-device "seen on phone" vs "seen on
  laptop" distinction. v1 uses a single per-actor
  watermark; per-device state is over-engineering.
- A push notification "you have N new items since
  last visit." Push lives in 0009 ntfy; pip surface
  is pull-only.
- Per-section toggle preferences ("don't show me
  PR pips, only anomalies"). v1 is uniform; per-
  section filtering is a follow-up.
- A historical "what was new on Monday" view. The
  pip surface is point-in-time; historical lives
  in 0038 and 0033.
- Cross-actor seen state ("if my teammate has
  already seen this, the pip is gone for me too").
  Single-actor by design - team views are out of
  scope for the personal-tool persona.
- A separate "unread count" badge on the favicon
  / browser tab title. The in-page banner is the
  surface; favicon manipulation is a follow-up.

## Engineering notes

- `src/views.ts` - new `newSinceLastVisit(db, now,
  actorKey, opts)` helper next to the existing
  `mondayCatchUp` and `yesterdayGlance`. The five
  sub-section SELECTs reuse existing tables (`pr`,
  `anomaly`, `inbox`, `alert`) with a single
  additional `created_at > ?` predicate per
  section. PRODUCER-VS-SPEC NOTE: grep
  `src/ingest/prs.ts` (line 164) for the actual
  `state` casing the production ingester writes
  for open vs merged PRs before composing any
  SELECT. Per LESSONS 2026-06-05 "groomer prose
  can disagree with the schema; the schema wins" -
  the producer is the contract.
- `src/views.ts` - new `markSectionSeen(db,
  actorKey, section, itemIds, now)` helper. The
  cursor JSON encoding is a flat array; the 200-
  id cap is enforced server-side. Per LESSONS § "no
  backticks inside template-literal SQL strings",
  identifiers stay plain.
- `src/server.ts` - two new routes
  (`GET /api/fleet/new-since-visit`,
  `POST /api/fleet/section-seen`) plus one
  ADDITIVE field (`previous_last_seen`) on the
  existing `/api/fleet` response. The previous-
  value lookup happens BEFORE the 0038 upsert
  runs. Per LESSONS § "expose a build counter for
  cache-hit tests, not a fetcher swap" - no
  memo cache here (per AC6 the route is
  `Cache-Control: no-store`), but the section-
  seen POST exposes a counter for tests via
  `_getSectionSeenWriteCountForTests()`.
- `web/app.js` - new
  `renderNewSinceBanner(data)` helper called from
  the existing home-page render path. New
  `IntersectionObserver` setup that watches every
  pipped card; the 2000ms threshold uses
  `requestAnimationFrame` to avoid timer drift.
  Batched POSTs use `navigator.sendBeacon` on
  `visibilitychange` and `fetch` otherwise. Per
  LESSONS § "defence-in-depth secret redaction at
  the renderer boundary", every operator-visible
  string passes through `redactSecrets`. The
  global `__fleet_seen_queue__` reset hook
  follows the `__fleet_<feature>_<verb>__`
  convention from LESSONS 2026-06-05 "break
  ingest<->server cache-invalidation cycles via a
  globalThis slot".
- `web/style.css` - one selector group for the
  banner, one for the pip (6px dot at 375px,
  inline label at >=600px), one for the
  quiet-hours muted variant. Reuse existing CSS
  variables.
- `tests/new-since-visit.test.ts` (new) - one
  `test(...)` per AC checkbox. Per LESSONS §
  "time-pinned tests must NOT derive seed
  timestamps from `new Date()`", every seed
  anchors to the test's pinned `now`. Per
  LESSONS § "in-process startServer() tests need
  an empty-roots config + run-row seeds",
  server-boot tests plant a tmp
  `fleet-control.config.json` in cwd and restore
  on cleanup.
- No new runtime deps. Pairs with 0038 (the
  watermark seam this ticket reuses), 0017 (the
  inbox is one of the five sections), 0033 (the
  daily glance is the recap counterpart; this is
  the within-day counterpart), 0030 (quiet hours
  styling), and 0011 (the mobile-portal CSS
  contract).

## Implementation log

- 2026-06-07 implementation-dev — picked up groomed
  ticket; branch feat/0043-new-since-last-visit-diff
  opened off main. Status flipped to in-progress.
  Producer-vs-spec audit: open PRs use `state='open'`
  lower-case (matches `src/ingest/prs.ts` line 164);
  merged PRs use `'MERGED'` upper-case (matches every
  other view in `views.ts`); `pr.fetched_at` is the
  merged-at proxy. Anomalies surface via the inbox
  pattern (created_at > last_seen AND dismissed_at IS
  NULL); inbox items reuse the existing fleetInbox
  rows (`payload.id` is the dedup key already).
  Alerts use `alert.created_at` and `resolved_at IS
  NULL` to surface only live alerts. No schema
  migration — reuses `watermark(source, cursor,
  updated_at)` exactly as 0038 did.
