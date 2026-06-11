---
id: 0054
title: Public weekly fleet pulse — stable /pulse URL renders the most-recent week so the prospect's bookmark stays warm
status: groomed
priority: P1
area: portal
created: 2026-06-11
owner: gtm-innovation
---

## User story

As a prospective fleet operator who saw a friend's `/receipts/<slug>/<month>`
(ticket 0041) two weeks ago, then closed the tab, and now wants a habit-
sized weekly check-in BEFORE installing — a tweet-shaped "what shipped this
week, what did it cost, what's the freshest lesson the agents learned" — I
want a single stable URL `/pulse` (no auth, no slug, no date in the path)
that always renders the most-recent COMPLETE week for this fleet, so that I
can bookmark it once and the bookmark stays warm across every visit
without me having to know the operator's slug or remember last month's URL.

## Why now (four lenses)

### Product Owner

0041 (monthly receipts) and 0050 (annual year-in-review) are the long-cycle
share artifacts. They live at slug-and-date URLs that the prospect must
EITHER bookmark per-period (May, June, July...) OR re-find via a thread.
Neither is a HABIT surface — there's no "the prospect opens it every
Monday morning to see what shipped this week" property because each URL is
a snapshot of one slice of time and goes stale by design.

The pulse fills the weekly cadence gap with the smallest meaningful unit
of value: ONE evergreen URL whose contents rotate to the latest complete
ISO week. The page composes the existing `fleetWeeklyDigest` /
`fleetStreak` / `lessonCreditRollup` helpers (already powering 0012,
0026, 0042) over a single-week window. No new schema. No new ingest path.
No publish-action surface (unlike 0041, the pulse is auto-published on
the boundary of every ISO week — the operator doesn't have to remember
to refresh it). Subtraction beats addition: this REMOVES the friction of
"is there a recent receipt for this fleet?" because the URL itself is
the answer.

PRODUCER-VS-SPEC NOTE: ISO week boundaries — Monday 00:00 UTC to
Sunday 23:59:59.999 UTC — must match the week boundary the existing
`fleetWeeklyDigest` helper uses (`src/digest.ts` or wherever the weekly
window lives). Grep first; the digest is the contract.

### Stakeholder

Widens the moat on the EVERGREEN-URL axis. 0041 receipts is a snapshot
URL (one month, frozen forever); 0050 year-in-review is a snapshot URL
(one year); 0015 status badge is an evergreen URL but per-project and
single-data-point. The pulse is the first FLEET-wide evergreen URL that
shows multiple stats. Per the cross-fleet courtiq lesson "tend the
lowest-numbered PR posture: the unglamorous-but-visible surface
prevents drift" (CROSS_LESSONS § courtiq Entries 2026-05-20 family), an
evergreen URL that auto-rotates is structurally impossible for any tool
that doesn't own both the data ingest AND the publishing surface — a
SaaS dashboard requires login; a tweet-thread snapshot goes stale; a
hosted blog post requires the operator to manually update. Only fleet-
control can auto-publish a fresh weekly URL without operator action,
because the daemon is already running on the operator's laptop and
already has the data.

The screenshot worth sharing: a `/pulse` URL that, when revisited a week
later, shows DIFFERENT numbers — the prospect's bookmark feels alive.
Pairs with 0041 (monthly snapshots are the long-cycle equivalent) and
0051 (the calculator's "install fleet-control" CTA can live in the
pulse's footer to convert the regular visitor).

### User (prospect on a phone, every Monday morning, 20 seconds)

The page is one short single-column scroll, server-rendered HTML, no
script. Top: the headline "Week of <Mon, YYYY-MM-DD> — N PRs shipped ·
$X.XX spent · $Y.YY per merged PR · streak <Z> days." Below that: three
short lines naming the top project by merged-PR count, the freshest
cross-fleet lesson authored this week (date + headline only, no body —
clicking links to `/lessons` per ticket 0057), and one "redemption" line
("0 sunset projects this week" or "1 paused — see `/graveyard`"). At
the bottom: a single CTA button "see the full receipts at /calculator"
(matches 0051's surface). At 375px viewport the four lines stack and
remain readable. Quiet hours suppresses the "see the calculator" CTA
button per the 0048 / 0050 / 0053 precedent (informational stays
visible; nudges suppressed).

When the fleet has shipped ZERO PRs this week, the page renders one
honest sentence: "The fleet is quiet this week — nothing shipped." (No
fabricated upbeat language; the prospect's authenticity-detection is
the load-bearing acquisition signal per CROSS_LESSONS § courtiq
share-flow authenticity 2026-05-25 family.)

### Growth

The "show me" moment turns a single share into a recurring impression.
Per the cross-fleet courtiq lesson "the prospect's churn risk is
concentrated in the moment they look at the surface and decide 'this
tool only shows me wins'" (CROSS_LESSONS § courtiq Entries 2026-05-25
family), the pulse's value INCREASES on a quiet week because the
honest "fleet is quiet" message reinforces "this number is real, not
marketing." The bookmark-warmth is the acquisition surface: every
prospect who bookmarks `/pulse` and visits weekly is a high-intent
operator the funnel was previously losing between snapshot views.

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: this
spec names `pr.state = 'MERGED'` (uppercase, agent), `run.outcome`
literals (the digest's existing convention — grep `src/views.ts` and
`src/digest.ts` for the fleetWeeklyDigest helper's literal `outcome`
casing per LESSONS 2026-06-10 "PRODUCER-VS-SPEC for column-value
casing"), and `lesson_credit.created_at` (used to find "freshest
lesson this week"). The schema is the contract — grep before writing.

- [ ] `src/views.ts` exports `fleetWeeklyPulse(db: DB, opts?:
      {now?: Date, hourlyRateUsd?: number}): FleetWeeklyPulse`
      returning `{generated_at: string, week_start_iso: string,
      week_end_iso: string, merged_prs: number,
      total_spend_usd: number, cost_per_pr_usd: number | null,
      streak_days: number, top_project: {slug: string,
      project_name: string, merged_prs: number} | null,
      freshest_lesson: {lesson_slug: string, lesson_date: string,
      lesson_title: string} | null, paused_count: number}`. The
      week boundary is Monday 00:00 UTC through Sunday 23:59:59.999
      UTC, snapped to the MOST RECENT COMPLETE week relative to
      `now` (i.e. if `now` is Wed 2026-06-10, the window is
      Mon 2026-06-01 through Sun 2026-06-07). `merged_prs` counts
      `pr` rows whose state matches the producer's "MERGED" casing
      AND `is_agent = 1` AND `fetched_at` falls in the window.
      `total_spend_usd` sums `cost_rollup_day.cost_usd` for `day`
      in the window. `cost_per_pr_usd` is null when merged_prs is
      zero. `streak_days` reuses the existing `fleetStreak()`
      helper (per `src/views.ts:683`). `top_project` is the
      project with the most merged PRs in the window (ties broken
      by slug ASC). `freshest_lesson` is the most-recently-credited
      `lesson_credit` row whose `created_at` falls in the window;
      null if none. `paused_count` reads `project_pause` for rows
      where `active = 1` (or whatever the producer's truthy
      convention is — grep `src/control.ts` per LESSONS 2026-06-05).
      Per LESSONS § "node:sqlite's .all() needs `as unknown as
      T[]`", every row narrowing uses the double cast. Per
      LESSONS § "time-pinned tests must NOT derive seed timestamps
      from `new Date()`", every seed anchors to the pinned `now`.
      Test: seed a fleet with 12 merged PRs in the target week
      and 3 in the prior week, assert merged_prs === 12 and the
      week boundary excludes the prior-week rows. Seed varied per-
      project counts, assert top_project's slug is the winner.
- [ ] Empty-week behaviour: a fleet with zero merged PRs in the
      window returns `merged_prs: 0`, `cost_per_pr_usd: null`,
      `top_project: null`, `freshest_lesson: null`. The page (AC4)
      renders one honest sentence "The fleet is quiet this
      week — nothing shipped." with `data-testid="pulse-empty"`.
      No fabricated upbeat copy; no broken numeric formatting.
      Test: render against a freshly-initialised DB, assert the
      empty testid is present and no per-stat testid appears.
- [ ] Idempotency / caching: the helper memoises per tuple
      `(MAX(pr.fetched_at), COUNT(*) FROM pr WHERE state =
      <merged-casing>, MAX(lesson_credit.created_at), COUNT(*)
      FROM lesson_credit, week_start_iso)`. Per LESSONS
      2026-06-07 "the `pr` table has no surrogate `id`; proxy
      'latest landed' via (MAX(fetched_at), COUNT(*))" — the PR
      signal MUST use `(MAX(pr.fetched_at), COUNT(*))`, NEVER
      `MAX(pr.id)`. Including `week_start_iso` in the key means
      the cache transparently rolls over at the Monday boundary
      without an explicit invalidation. Per LESSONS § "in-process
      dedup sets need an explicit reset hook for tests", expose
      `_resetPulseCacheForTests()` AND
      `_getPulseCacheBuildsForTests()` per LESSONS § "expose a
      build counter for cache-hit tests, not a fetcher swap".
      Per LESSONS 2026-06-05 "break ingest↔server cache-
      invalidation cycles via a globalThis slot", the
      invalidation hook MUST register on
      `globalThis.__fleet_pulse_invalidate__` from `src/server.ts`
      and be read lazily by `runIngestPass` after COMMIT — never
      a direct import from `src/ingest/index.ts` back to
      `src/server.ts`. Test: two calls within TTL assert one
      build via the build counter; seed a fresh PR, assert the
      next call rebuilds.
- [ ] `GET /pulse` (no auth — public route) renders a self-
      contained single-column HTML page. NO `<script>` tag, NO
      reference to `/api/control/`, NO project list other than
      `top_project.slug`. Content-Type `text/html; charset=
      utf-8`. The page lives in the SAME outer handler family as
      `/share/<token>`, `/receipts/<slug>/<month>`, `/year/<YYYY>`
      so it inherits the no-token bypass (per `src/server.ts:
      ~3088-3110`). Sets `Cache-Control: max-age=3600` (1h — the
      digest moves slowly within a week). Headline carries
      `data-testid="pulse-headline"`. Each stat carries
      `data-testid="pulse-merged-prs"`, `-spend`, `-cost-per-pr`,
      `-streak`, `-top-project`, `-freshest-lesson`, `-paused-
      count`. The CTA button carries `data-testid="pulse-cta"`
      and links to `/calculator`. Per LESSONS § "defence-in-
      depth secret redaction at the renderer boundary", the
      rendered HTML passes through `redactSecrets` before
      `res.end` BUT per LESSONS 2026-06-10 "redactSecrets on a
      JSON body shreds your KEYS" — the redactor is applied to
      operator-derived STRING VALUES (project name, lesson
      title, slug) BEFORE composition into HTML, never to the
      whole document string. Test: hit without auth, assert 200
      with the headline testid; assert no `/api/control/`
      substring in the response.
- [ ] `GET /api/fleet/pulse` returns the AC1 shape as JSON. NO
      auth required (the pulse JSON is the same public surface as
      the HTML page). Sets `Cache-Control: max-age=3600`. The
      response NEVER includes per-project rows beyond
      `top_project` (single project), never includes PR titles or
      bodies, never includes the operator's full project list.
      Per LESSONS § "defence-in-depth secret redaction at the
      renderer boundary" and 2026-06-10 "redactSecrets on a JSON
      body shreds your KEYS" — scrub the operator-supplied
      string VALUES (project_name, lesson_title) BEFORE
      `JSON.stringify`, never the body string. Test: hit
      without auth → 200 with the shape; assert no field other
      than `top_project.slug`/`top_project.project_name`
      surfaces a project identifier; assert
      `freshest_lesson.lesson_title` survives intact even when
      the title contains an underscore-laden identifier (the
      regression test for the 2026-06-10 lesson).
- [ ] Mobile (per 0011): at 375px viewport the headline +
      stats stack vertically, the CTA button is full-width with
      at least 44px tap height. At >= 600px the stats render
      inline as a single-row tile. Test: assert the existing
      mobile-portal text-level CSS contract at 375px (stacked)
      and 600px (inline) viewport widths.
- [ ] Quiet-hours integration (per 0030): when
      `quietHoursActive` is `true`, the CTA button is hidden (a
      midnight visit should not nudge the prospect into an
      impulsive install). The headline, stats, and lesson line
      remain visible. The empty-week sentence is unchanged
      (honest copy is honest regardless of hour). Test: stub
      quiet hours active, assert no `pulse-cta` testid; stub
      inactive, assert the CTA is present.
- [ ] Defensive privacy: the response NEVER includes per-PR
      titles, per-run cost breakdowns, the operator's full
      project list (beyond `top_project`), or any field that
      could deanonymise the fleet to a stranger. Static test
      asserts: grep the `/pulse` response body for the literal
      strings `"transcript_path"`, `"repo_url"`, `"branch"`,
      `"admin_token"`, `"pr_title"` and assert none appear.
      Per LESSONS § "'no shell-string exec' static checks
      should grep the import, not the call site", this static
      check greps the RESPONSE STRING — the leak chokepoint.
      Test: seed a realistic fleet, hit `/pulse` and
      `/api/fleet/pulse`, assert none of the leak-pattern
      strings appears in either body.
- [ ] Cross-link from existing surfaces: the existing
      `/receipts/<slug>/<month>` and `/year/<YYYY>` HTML pages
      grow ONE footer line "see this week's pulse at /pulse"
      with `data-testid="pulse-cross-link"`. This is an
      additive HTML change, NOT a JSON-shape break. PRODUCER-
      VS-SPEC NOTE: grep `src/server.ts` for the receipts /
      year HTML render path before placing the footer.
      Test: hit a published `/receipts/<slug>/<month>`, assert
      the pulse-cross-link testid is present with href
      `/pulse`; hit `/year/<YYYY>`, same assertion.
- [ ] Performance: `fleetWeeklyPulse(db, opts)` against a
      seeded fleet of 6 projects and 500 PRs completes in
      under 50ms (cache miss) and under 5ms (cache hit). Per
      LESSONS § "in-process startServer() tests need an empty-
      roots config + run-row seeds", server-boot tests plant a
      tmp `fleet-control.config.json` in cwd and restore on
      cleanup. Per LESSONS § "julianday() drifts ~10us per
      timestamp", any week-boundary timestamp diff uses
      `strftime` decomposition. Test: seed the dataset, time
      both paths, assert thresholds (skip when `process.env.
      PERF !== "1"`).
- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-
      string composition. The HTML page is mounted as a NET-
      NEW route (no JSON-shape break to any existing
      `/api/...` route). The additive footer line on
      `/receipts/<slug>/<month>` and `/year/<YYYY>` is HTML-
      only — no JSON field changes. No schema migration —
      composes existing `pr`, `cost_rollup_day`, `run`,
      `lesson_credit`, `project_pause`, `project` tables. Per
      LESSONS § "no backticks inside template-literal SQL
      strings", identifiers stay plain words.

## Out of scope

- A historical pulse archive (`/pulse/<YYYY-WW>`). The MVP is
  the evergreen most-recent-week URL only; historical weeks
  are a follow-up and arguably already covered by 0041 monthly
  receipts and 0050 year-in-review.
- An RSS/Atom feed of weekly pulses. The URL is the bookmark
  shape; feed subscriptions are a follow-up that requires
  thinking about authentication for private fleets.
- A "subscribe to email digests" surface. The pulse is pull-
  only by design — same posture as 0041 receipts, 0050 year-
  in-review, 0015 badge, 0036 lessons, 0051 calculator.
- An LLM-authored "what's interesting this week" paragraph.
  The prose is deterministic template; the stats carry the
  meaning.
- A "pulse for the prior week" toggle on the page. Adding a
  toggle invites debate about how many weeks to show; the
  evergreen URL design intentionally enforces "just this one
  week, always fresh."
- An auto-publish to social platforms (Twitter, Mastodon).
  The URL is the share artifact; pushing it out is the
  operator's decision.
- A "compare to last week" diff badge ("+3 PRs vs last
  week"). The comparison is a follow-up — first prove the
  evergreen URL drives bookmarking.
- Multi-fleet (cross-operator) aggregation. Single-fleet by
  design, matching the rest of the surface.
- Auth-gating the pulse. Public by design — same posture as
  `/receipts/<slug>/<month>`, `/year/<YYYY>`, `/calculator`,
  `/badge/<slug>.svg`.

## Engineering notes

- `src/views.ts` — new `fleetWeeklyPulse(db, opts)` helper
  near the existing `fleetWeeklyDigest` / `fleetStreak` (line
  ~683) / `lessonCreditRollup` (line ~4006). PRODUCER-VS-SPEC
  NOTE: grep `src/digest.ts` (or wherever the weekly digest
  lives) for the existing week-boundary helper before
  reinventing one — the Monday-anchor logic likely already
  exists and the pulse should reuse it for byte-identical
  boundaries. Per LESSONS § "node:sqlite's .all() needs `as
  unknown as T[]`", every row narrowing uses the double cast.
- `src/server.ts` — two new handlers near the existing
  receipts / year routes (lines ~2110, ~3088, ~3102):
  `GET /pulse` (HTML, public, no auth) and `GET /api/fleet/
  pulse` (JSON, public, no auth). Per LESSONS 2026-06-05
  "break ingest↔server cache-invalidation cycles via a
  globalThis slot", the pulse cache invalidation function
  MUST be registered on `globalThis.__fleet_pulse_invalidate__`
  from `src/server.ts` and read lazily by `runIngestPass`.
  Per LESSONS § "in-process startServer() tests need an
  empty-roots config + run-run seeds", server-boot tests
  plant a tmp `fleet-control.config.json` in cwd and restore
  on cleanup.
- `src/server.ts` — additive footer line on the existing
  `/receipts/<slug>/<month>` and `/year/<YYYY>` HTML render
  paths. PRODUCER-VS-SPEC NOTE: grep `src/server.ts` for the
  exact `</main>` / `</body>` insertion point and the
  existing footer copy ("Generated by fleet-control...")
  before composing the new line; reuse the existing footer
  CSS class so the new line inherits the styling.
- `tests/pulse.test.ts` (new) — one `test(...)` per AC
  checkbox. Per LESSONS § "time-pinned tests must NOT derive
  seed timestamps from `new Date()`", every seed anchors to
  the test's pinned `now`. Per LESSONS § "in-process
  startServer() tests need an empty-roots config + run-row
  seeds", server-boot tests plant a tmp `fleet-control.
  config.json` in cwd and restore on cleanup. Per LESSONS §
  "anomaly tests need σ > 0 in the fixture", seed varied
  per-project PR counts so `top_project` selection is
  geometrically meaningful (not a tie). Per LESSONS §
  "expose a build counter for cache-hit tests, not a fetcher
  swap", AC3 uses the build counter. Per LESSONS § "when an
  ingester grows a second shell-out, legacy stubs that don't
  discriminate on argv silently collide" — the pulse cache
  invalidation hook may need the test stub to fire after
  ingest, mirroring the 0042 / 0052 invalidation tests.
- `web/app.js` — NO change. `/pulse` is a server-rendered
  standalone HTML page (matches the 0041 receipts pattern
  and the 0050 year-in-review pattern); the SPA does not
  need a hash route for it.
- `web/style.css` — one selector group for the pulse page
  (reuse the receipts page's structural CSS). Reuse
  existing CSS variables for color and font; do NOT add
  new ones.
- Schema migration: NO new tables. Composes existing `pr`,
  `cost_rollup_day`, `run`, `lesson_credit`, `project_pause`,
  `project` tables.
- No new runtime deps. Pairs with 0012 (weekly digest —
  the data is the same week's data, formatted for a public
  surface), 0041 (monthly receipts — the long-cycle
  equivalent, slug+date URL), 0050 (year-in-review —
  the annual equivalent), 0051 (calculator — the pulse's
  CTA links here), 0042 (lesson credit — provides the
  freshest_lesson), 0026 (streak — provides the
  streak_days), 0030 (quiet hours — suppresses the CTA).

## Implementation log

(Appended by the implementation-dev agent during execution.)
