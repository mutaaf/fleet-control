---
id: 0058
title: Public failure-mode landing pages - anonymised /failures/<signature> SEO surface authored from real cross-project correlations the fleet caught
status: in-progress
priority: P1
area: portal
created: 2026-06-13
owner: gtm-innovation
---

## User story

As an external developer at 10pm Googling "TS2304 cannot find name" or
"remote: Permission denied git push" because their CI just lit up red, with
NO knowledge of fleet-control's existence, I want the search to surface a
public anonymised failure-mode page at `/failures/<signature>` (no auth,
indexable by crawlers) where the page renders: the signature in plain
English, a 200-char sample excerpt (anonymised), how many distinct projects
have hit this failure in the last 90 days across the fleet, and a single
"this signature was first caught by the autonomous agent fleet running
fleet-control on YYYY-MM-DD" line plus the install CTA, so that the moat
that is "we ingest failure correlations across projects nobody else can
see" (per 0027) doubles as an acquisition surface: the developer lands on
the page, recognises their problem in the excerpt, scrolls to the link to
the matching lesson (per 0057), and discovers a tool that authored the
fix from real telemetry.

## Why now (four lenses)

### Product Owner

0027 (cross-project failure correlation) already detects when N>=2
projects in the fleet hit the same `failureSignature` within a 24h
window. 0057 (public lesson archive) exposes the cross-fleet lessons
file publicly. Neither surface answers the question "what failure modes
has this fleet actually CAUGHT" from a SEARCH perspective — the lesson
archive is keyed by lesson title/date (good for someone Googling a
specific lesson phrase, poor for someone Googling a raw error string),
and the correlation inbox is operator-only.

This ticket opens a NEW public route `/failures` (the index) and
`/failures/<signature>` (one page per signature the fleet has caught
within the last 90 days). The signature is the exact key from
`correlate.ts:failureSignature()` — `TS2304`, `git-push-403`,
`gh-missing`, `node-missing`, `npm-eacces` are the current set. Each
page renders: the plain-English title ("TypeScript: cannot find name -
TS2304"), a 200-char anonymised sample excerpt, the number of distinct
project aliases that hit it in the trailing 90 days, the first-seen
and last-seen dates, and a deep-link to any matching cross-fleet
lesson whose title or body mentions the same signature substring
(common case for `TS2304` and `redactSecrets` family).

Smallest meaningful unit of value: ONE public route exposing content
the fleet already detects. No new schema. No new ingest path. No new
LLM call.

PRODUCER-VS-SPEC NOTE: per LESSONS 2026-06-05 "groomer prose can
disagree with the schema" and 2026-06-07 "the `pr` table has no
surrogate `id`" - the failure rows live on `anomaly`
(`kind = 'fleet_correlated'`, `correlation_signature` column) AND on
`pr` (`first_fail_check`, `first_fail_excerpt`) - grep `src/db.ts`
and `src/correlate.ts` for the column casing
(`correlation_signature` is lowercase per `ALTER TABLE anomaly ADD
COLUMN correlation_signature TEXT`) BEFORE writing the SELECT. The
existing helper `activeCorrelations(db, now)` returns the in-window
list; this ticket extends to a 90-day window and groups by
signature.

### Stakeholder

Widens the moat on the ZERO-COMPETITION SEO axis. 0057 (lesson
archive) competes against existing technical blog content for the
"node:sqlite .all() narrowing" query. The failure-mode pages compete
against NOTHING - no blog post lists "every cross-project
TypeScript error my agent fleet caught in the last 90 days with a
sample excerpt and a link to the fix." Per the cross-fleet courtiq
lesson "any public artifact that helps a stranger BEFORE they
install your tool is the cheapest acquisition surface" (CROSS_LESSONS
section courtiq Entries 2026-05-21 family on share-flow), the
failure-mode index is exactly that artifact applied to the rarest
content - raw telemetry from a running fleet.

Per the cross-fleet courtiq lesson "an asset that pays rent the
operator can't see is functionally dark code" (CROSS_LESSONS
section courtiq Entries 2026-05-21 family - the inverse formulation
echoed in 0056's groomed why-now), the correlation rows are dark
code today (only the operator sees them); this ticket turns them
into rent-paying SEO assets.

The screenshot worth sharing: a Google SERP with
`/failures/git-push-403` as the top result for "remote permission
denied git push 403" - a surface that no SaaS dashboard tool can
author because the correlation requires owning the full ingest
pipeline.

### User (external developer at 10pm, debugging)

Two surfaces:
1. `/failures` - a single long single-column scroll, server-rendered
   HTML (NO `<script>`), every signature visible as an H2 header, the
   count of projects affected, and the first/last-seen dates. Top
   header: "failure modes the fleet has caught across N projects in
   the last 90 days." Crawler-indexable. Each signature row links to
   the permalink form. Foot: install CTA.
2. `/failures/<signature>` - a per-signature page, the SAME content
   but with ONE signature as primary content, a sample excerpt
   rendered as a `<pre>` block, and a deep link to any matching
   cross-fleet lesson (looked up via substring match in
   lesson titles and lesson bodies via the existing
   `lessonsPublicArchive()` helper).

The pages are mobile-first (375px, one column, no horizontal
scroll). They work on a flaky cellular connection because no
JavaScript runs. Each page sets `<meta name="robots"
content="index,follow">` AND `<link rel="canonical">` to the
permalink form so the index page doesn't compete with the
permalink page for ranking.

Crucially: the excerpt PROSE is preserved verbatim - that's the SEO
content. Per 0013's anonymisation discipline AND 0057's existing
anonymiser shape, the excerpt is scrubbed of operator-supplied
proper nouns (project slugs become `project-N` alias; absolute
paths become `<path>`; branch names become `<branch>`) but the
technical error text, file extensions, error codes, and SQL
snippets are preserved. Example: a sample
`/Users/alice/courtiq-prod/src/foo.ts:42 - TS2304 Cannot find
name 'Bar'` becomes `<path>:42 - TS2304 Cannot find name 'Bar'`.

When no projects are hitting any signature in the last 90 days
(an empty fleet or a quiet quarter), `/failures` renders one
honest sentence: "The fleet has not caught any cross-project
failures in the last 90 days." Per CROSS_LESSONS section courtiq
share-flow authenticity 2026-05-25 family, honest empty-states
preserve the trust the live numbers earn.

### Growth

The "show me" moment is the inbound search-traffic conversion at
peak distress - a developer Googling at 10pm with their CI red is
the highest-intent prospect fleet-control can find. Per the cross-
fleet courtiq lesson "the prospect who arrives with a specific
problem solved is 10x more likely to convert than the prospect who
arrives with curiosity" (CROSS_LESSONS section courtiq Entries
2026-05-21 family), the failure-mode pages are the highest-intent
acquisition funnel of any public surface fleet-control authors.
Pairs with 0057 (lesson archive - same SEO posture, different
content axis) and 0027 (correlation detector - the data source).
The two SEO surfaces are complementary: the lesson archive is keyed
by "lesson title" (good for Googling phrases from a debug session
post-mortem); the failure-mode pages are keyed by "raw error
substring" (good for Googling the actual stderr line the developer
just copy-pasted from their failing terminal).

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: per
LESSONS 2026-06-05 "groomer prose can disagree with the schema; the
schema wins" the implementing dev MUST grep `src/db.ts` for the
`anomaly` and `pr` column shapes before writing the SELECT. The
`anomaly` table carries `correlation_signature` (lowercase, TEXT,
nullable, populated only when `kind = 'fleet_correlated'`); the
`pr` table carries `first_fail_check` and `first_fail_excerpt`
(both nullable). Per LESSONS 2026-06-07 "the pr table has no
surrogate id" - any cache invalidation tuple uses
`(MAX(fetched_at), COUNT(*))` over `pr`, NOT `MAX(id)`. Per LESSONS
2026-06-10 "PRODUCER-VS-SPEC for column-value casing" - the
`pr.state` literal is `'open'` lowercase (grep
`src/ingest/prs.ts`) and the existing `correlate.ts:detectCorrelations`
already uses `pr.state = 'open'` - mirror that casing.

- [ ] `src/views.ts` exports `fleetFailureModes(db: DB, opts?:
      {now?: Date, windowDays?: number, projectAliasMap?:
      Record<string, string>}): FleetFailureModes` returning
      `{generated_at: string, window_days: number,
      total_signatures: number, total_projects_affected: number,
      signatures: Array<{signature: string, title: string,
      sample_excerpt_anonymised: string, project_count: number,
      pr_count: number, first_seen_at: string, last_seen_at:
      string, matched_lesson_slug: string | null}>}`. The helper
      groups `pr` rows where `first_fail_excerpt IS NOT NULL` AND
      `fetched_at >= now - windowDays days` by the output of
      `failureSignature(first_fail_check, first_fail_excerpt)` from
      `src/correlate.ts`; `project_count` is the COUNT(DISTINCT
      slug) per group; `pr_count` is the row count per group; the
      sample excerpt is the FIRST excerpt seen per group, truncated
      to 200 chars and anonymised via the same anonymisation pass
      as 0057's `lessonsPublicArchive()`. `title` is a fixed
      english phrase per signature
      (`TS2304 -> "TypeScript: cannot find name"`,
      `git-push-403 -> "git push: permission denied"`,
      `gh-missing -> "gh CLI not found on PATH"`, etc.) -
      hardcoded in a small switch in `src/views.ts`. The
      `matched_lesson_slug` looks up the existing
      `lessonsPublicArchive()` output for any lesson whose title
      OR body contains the signature substring; first match wins;
      null when none matches. Default `windowDays = 90`. Per
      LESSONS section "node:sqlite's .all() needs `as unknown as
      T[]`" the row narrowing uses the double cast. Per LESSONS
      section "time-pinned tests must NOT derive seed timestamps
      from `new Date()`" every seed anchors to the pinned `now`.
      Test: seed 3 PR rows with distinct slugs all containing
      `error TS2304: Cannot find name 'X'`, plus 1 row containing
      `npm WARN EACCES /usr/local/lib`, advance time, assert
      `signatures` has both `TS2304` (`project_count: 3`,
      `pr_count: 3`) and `npm-eacces` (`project_count: 1`,
      `pr_count: 1`); assert the excerpt is anonymised and
      truncated to <= 200 chars; assert window cut excludes rows
      older than `now - 90 days`.

- [ ] `GET /failures` (no auth - public route) renders a self-
      contained single-column HTML page listing every signature
      from AC1, mounted in the SAME outer handler family as
      `/lessons-public`, `/pulse`, `/receipts/<slug>/<month>`. NO
      `<script>` tag, NO reference to `/api/control/`, NO operator
      project list. Content-Type `text/html; charset=utf-8`. Sets
      `Cache-Control: max-age=3600`. Sets `<meta name="robots"
      content="index,follow">` AND `<link rel="canonical"
      href="/failures">`. The page top carries
      `data-testid="failures-public-header"` with the summary
      line. Each signature section has `<h2 id="<signature>"
      data-testid="failure-public-<signature>">`. The page footer
      carries `data-testid="failures-public-cta"` with the install
      link. Per LESSONS section "defence-in-depth secret
      redaction at the renderer boundary", the rendered HTML
      passes excerpt strings through `redactSecrets` BEFORE
      composition into HTML (the anonymisation is a separate pass;
      redactSecrets is the defence-in-depth backstop). Per LESSONS
      2026-06-12 "greedy `[^>]+id=` regex over a `<h2 id="..."
      data-testid="...">`" - the test anchors on the
      `data-testid="failure-public-..."` attribute, NOT a greedy
      `id=` match. Test: hit without auth, assert 200 with the
      header testid; assert no operator project slug appears in
      the response; assert canonical and robots meta tags present.

- [ ] `GET /failures/<signature>` (no auth - public route)
      renders ONE signature as primary content. Sets `<link
      rel="canonical" href="/failures/<signature>">` AND `<meta
      name="robots" content="index,follow">`. Renders the title
      as `<h1>` (SEO H1 signal), the signature code as a `<code>`
      element, the anonymised sample excerpt as a `<pre>` block,
      a `<dl>` listing project_count / pr_count / first_seen /
      last_seen, and (when `matched_lesson_slug` is non-null) a
      "see the matching lesson at /lessons-public/<slug>" deep
      link. Includes a "back to all failure modes" link at the
      top. Returns 404 with a friendly HTML page when the
      signature is unknown OR has no rows in the window. Sets
      `Cache-Control: max-age=3600`. Test: hit `/failures/TS2304`
      against the seeded fixture, assert 200 with the H1 and the
      `<pre>` excerpt; hit `/failures/foo-not-real`, assert 404;
      hit `/failures/TS2304` and assert the matched-lesson deep
      link is present when a `TS2304`-naming lesson exists in
      the archive.

- [ ] Anonymisation regression: a static test seeds 3 PR rows
      with operator-leaking text patterns in `first_fail_excerpt`
      (a real-looking project slug `courtiq-prod`, an absolute
      path `/Users/alice/code/courtiq`, a branch name
      `feat/secret-feature-x`, a GitHub PAT pattern `ghp_
      abcdef1234567890abcdef1234567890abcd`), renders the
      `/failures/<signature>` HTML, asserts NONE of the leak
      patterns appears in the body. Per LESSONS section "'no
      shell-string exec' static checks should grep the import,
      not the call site" this static check greps the RENDERED
      HTML STRING. Per LESSONS 2026-06-10 "redactSecrets on a
      JSON body shreds your KEYS" - the page is HTML (not JSON),
      so the redactor pass over the composed body string is
      appropriate; assert the page STRUCTURE (the H1, the `<pre>`
      tag, the `<dl>`) survives the redaction pass.

- [ ] `GET /api/failures` (no auth - public route, mirrors the
      `/api/lessons-public` posture from 0057) returns the AC1
      shape as JSON. Sets `Cache-Control: max-age=3600`. Per
      LESSONS 2026-06-10 "redactSecrets on a JSON body shreds
      your KEYS" - scrub `sample_excerpt_anonymised` and `title`
      VALUES BEFORE `JSON.stringify`, NEVER the body string. Per
      LESSONS section "PRODUCER-VS-SPEC for column-value casing"
      - assert the `signature` field is one of the closed set
      from `failureSignature` (regex
      `^(TS\d{4}|git-push-403|gh-missing|node-missing|npm-eacces)$`)
      so a future ingester adding a new signature shape can't
      silently widen the public surface without an explicit
      schema update. Test: hit without auth -> 200 with the
      shape; assert `signature` matches the closed regex; assert
      no field carries the operator's real project slug.

- [ ] Idempotency / caching: the failure-modes helper memoises
      per tuple `(MAX(pr.fetched_at), COUNT(*) over pr in window,
      operator alias map version)`. Per LESSONS 2026-06-07
      "the pr table has no surrogate id" - the helper uses
      `(MAX(fetched_at), COUNT(*))` NOT `MAX(id)`. Per LESSONS
      section "in-process dedup sets need an explicit reset
      hook for tests", expose
      `_resetFailureModesCacheForTests()` AND
      `_getFailureModesCacheBuildsForTests()`. Per LESSONS
      2026-06-05 "break ingest<->server cache-invalidation
      cycles via a globalThis slot", the invalidation hook
      registers on
      `globalThis.__fleet_failure_modes_invalidate__`. Test:
      two calls within the cache tuple assert one build via
      the build counter; insert a fresh `pr` row in window,
      assert the next call rebuilds.

- [ ] Mobile (per 0011): at 375px the `/failures` page is one
      column with comfortable reading width; the `<pre>` excerpt
      block scrolls horizontally inside its own container,
      never breaking the page layout. At >=900px the page renders
      centred at 80ch max-width for legibility. Per LESSONS
      2026-06-11 "startServer() tests that mutate
      `fleet-control.config.json` race against parallel test
      files; expose a renderer-direct seam for branch tests" -
      the mobile branch is exercised via a renderer-direct
      `_renderFailureModesPageForTests(payload, {viewportWidth:
      375})` seam, NOT a config mutation.

- [ ] Cross-link from existing surfaces: the authenticated
      `/lessons` page (per 0036) AND the `/lessons-public` page
      (per 0057) each grow ONE footer line "see the failure
      modes the fleet has caught at /failures" with
      `data-testid="lessons-failure-modes-cross-link"`. This is
      an additive HTML change, NOT a JSON-shape break. Test: hit
      `/lessons-public`, assert the cross-link testid is present
      with href `/failures`; hit the authenticated `/lessons`,
      same assertion.

- [ ] Performance: `fleetFailureModes()` against a 1000-PR
      fixture completes in under 100ms (cache miss) and under
      5ms (cache hit). The rendered `/failures` HTML page size
      is under 100KB uncompressed for any realistic signature
      count (<= 50 signatures). Per LESSONS section "in-process
      startServer() tests need an empty-roots config + run-row
      seeds", server-boot tests plant a tmp
      `fleet-control.config.json` in cwd and restore on
      cleanup. (Skip perf assertions when
      `process.env.PERF !== "1"`.)

- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-
      string composition. The HTML pages are mounted as NET-NEW
      routes (no JSON-shape break to any existing `/api/...`
      route). The additive footer lines on `/lessons` and
      `/lessons-public` are HTML-only - no JSON field changes.
      No schema migration - composes existing `pr` and `project`
      tables plus the existing 0057 anonymiser. Per LESSONS
      section "no backticks inside template-literal SQL
      strings", identifiers stay plain words. Per LESSONS
      2026-06-11 "character-window source greps leak into
      sibling helpers; backticked identifiers in adjacent
      comments break the slice" - the new helper's comment
      block uses PLAIN PROSE (no backticks) for any identifier
      that a 0052-family `slice(indexOf(name), idx + N)` test
      might capture.

## Out of scope

- A sitemap.xml of every failure-mode permalink. Crawlers will
  discover the permalinks via the index page's `<h2 id>` links.
- An RSS/Atom feed of newly-detected failure modes.
- A "post my fleet's failure modes here" inbound submission form.
  The corpus is downstream of the operator's OWN agents.
- LLM-generated remediation prose. The matched-lesson deep link
  is the remediation surface; LLM summarisation invites cost,
  hallucination, and a phone-home posture fleet-control rejects.
- A "rate this failure mode" reaction surface. The page is read-
  only by design.
- Per-failure-mode view counts. Analytics violate the no-phone-
  home posture.
- Adding new failure signatures to `correlate.ts:failureSignature`.
  Out-of-scope for this ticket - it consumes the existing closed
  set. A follow-up ticket can widen the signature regex catalog.
- A historical archive page (signatures the fleet caught >90 days
  ago but no longer hits). v1 windows to the last 90 days; older
  signatures are out of scope.

## Engineering notes

- `src/views.ts` - new `fleetFailureModes(db, opts)` helper next
  to the existing `prAutopsies` / `stuckPrTaxonomy` /
  `riskiestOpenPr` family. PRODUCER-VS-SPEC NOTE: grep
  `src/views.ts` for the existing `riskiestOpenPr` SELECT shape
  (it already JOINs `pr` and `project` against
  `first_fail_check`/`first_fail_excerpt`) and mirror the
  column casing. The signature-derivation step calls
  `failureSignature(first_fail_check, first_fail_excerpt)` from
  `src/correlate.ts`; reuse the existing exported function
  rather than copy-pasting the regex catalog. Per LESSONS 2026-
  06-11 "character-window source greps leak into sibling
  helpers" - the new helper sits next to `riskiestOpenPr` /
  `stuckPrTaxonomy`; the new helper's leading comment block
  uses PLAIN PROSE for any identifier (no backticks around
  `lessonSavingsRollup`, `riskiestOpenPr`, etc.) so the
  existing character-window source greps in 0052 / 0040 tests
  don't capture across the helper boundary.
- `src/views.ts` - share the 0057 anonymisation pass (project
  slug -> alias; `/Users` and `/home` -> `<path>`; agent branch
  prefix -> `<branch>`; PR number unchanged). PRODUCER-VS-SPEC
  NOTE: grep `src/lessons.ts` for the existing anonymiser
  helper - if it's exported, REUSE it rather than re-author.
- `src/server.ts` - three new handlers near the existing
  `/lessons-public` / `/pulse` / `/calculator` routes:
  `GET /failures` (HTML, public, no auth), `GET
  /failures/<signature>` (HTML, public, no auth), `GET
  /api/failures` (JSON, public, no auth). All three MUST mount
  BEFORE the `path.startsWith("/api/")` auth gate so they share
  the `/pulse` / `/lessons-public` no-auth posture. Per LESSONS
  2026-06-05 "break ingest<->server cache-invalidation cycles
  via a globalThis slot", the invalidation function registers on
  `globalThis.__fleet_failure_modes_invalidate__` from
  `src/server.ts` on module load; the ingest pass reads it
  lazily after a fresh `pr` row lands.
- `src/server.ts` - additive footer line on the existing
  `/lessons` (per 0036) AND `/lessons-public` (per 0057) HTML
  render paths. PRODUCER-VS-SPEC NOTE: grep `src/server.ts`
  for the existing `/lessons` and `/lessons-public` handlers
  before placing the line. The line is HTML-only; no JSON
  field changes.
- `tests/failure-modes.test.ts` (new) - one `test(...)` per
  AC checkbox. Per LESSONS section "time-pinned tests must
  NOT derive seed timestamps from `new Date()`", every seed
  anchors to the pinned `now`. Per LESSONS section "in-
  process startServer() tests need an empty-roots config +
  run-row seeds", server-boot tests plant a tmp
  `fleet-control.config.json` in cwd and restore on cleanup.
  Per LESSONS 2026-06-11 "startServer() tests that mutate
  `fleet-control.config.json` race against parallel test
  files; expose a renderer-direct seam for branch tests" -
  mobile-breakpoint / empty-fleet / unknown-signature branches
  drive the renderer directly via
  `_renderFailureModesPageForTests` /
  `_renderFailurePermalinkForTests` seams, NOT cwd config
  mutation. Per LESSONS 2026-06-12 "greedy `[^>]+id=` regex
  over a `<h2 id="..." data-testid="...">` captures the wrong
  attribute" - any HTML attribute grep in the tests anchors on
  the `data-testid="failure-public-..."` substring, never a
  greedy `id=` match.
- `web/style.css` - one selector group for the failure-mode
  pages (centred max-width 80ch, legible body type, `<pre>`
  block scrolls horizontally inside its own container,
  reuses lessons-public structural CSS from 0057). Reuse
  existing CSS variables for color and font; do NOT add new
  ones.
- Schema migration: NO new tables. Composes existing `pr`,
  `project`, `anomaly` tables plus the existing 0057
  `lessonsPublicArchive()` helper for the matched-lesson
  deep link.
- No new runtime deps. Pairs with 0027 (cross-project
  correlation - the data source), 0057 (lesson archive -
  same SEO posture), 0051 (calculator - sibling public
  acquisition surface), 0036 (authenticated lessons portal
  - the cross-link target), 0013 (anonymisation discipline).

## Implementation log

- 2026-06-13: scoping commit — branch `feat/0058-public-failure-mode-landing-pages`
  off origin/main; ticket flipped groomed → in-progress; index row updated.
  Plan: TDD one test() per AC in `tests/failure-modes.test.ts`, then add
  `fleetFailureModes()` next to `fleetWeeklyPulse` in src/views.ts (PLAIN
  PROSE comment per LESSONS 2026-06-11), three public HTML/JSON routes in
  src/server.ts (mounted BEFORE the `path.startsWith("/api/")` auth gate,
  mirroring `/api/lessons-public`), exposed renderer-direct seams
  `_renderFailureModesPageForTests` / `_renderFailurePermalinkForTests`,
  cache reset + builds counter, globalThis invalidation slot
  `__fleet_failure_modes_invalidate__`.
- 2026-06-13: shipped end-to-end. All 16 tests in tests/failure-modes.test.ts
  pass (AC9 perf skipped behind PERF=1). Local gate `npm ci && npx tsc
  --noEmit && node scripts/check-backlog.mjs` green. PRODUCER-VS-SPEC
  reconciliations: `pr` table has no surrogate `id` so the cache tuple uses
  `(MAX(fetched_at), COUNT(*))` not MAX(id) (per LESSONS 2026-06-07);
  `pr.state` literal is lowercase `'open'` though the helper does NOT
  restrict on state - dark closed-and-failing PRs are part of the SEO
  signal too. Cycle avoidance: lessons.ts already imports views.ts, so I
  inlined a local `anonymiseExcerpt` in views.ts instead of round-tripping
  through lessons.ts (would have created lessons↔views cycle). Cache
  seam exposed via `_failureModesCachedForTests` mirrors the 0057
  `_lessonsPublicArchiveCachedForTests` pattern so the AC6 cache test
  drives the build counter through the cached path. Pre-existing test
  failures on main (correlate AC9, weekly digest, leaderboard, several CLI
  spawn-timeout tests) are NOT from this change and NOT on the gating
  surface (typecheck + validate); they predate this PR per LESSONS
  2026-05-29 "distinguish test red in MY change from test red for
  reasons that predate my change".
- Sibling cache invalidation wired in src/ingest/index.ts via globalThis
  slot `__fleet_failure_modes_invalidate__` (no import cycle per LESSONS
  2026-06-05).
- AC8 cross-link footers added to BOTH the authenticated `#/lessons` SPA
  (web/app.js, line ~4427) AND the public `/lessons-public` HTML
  (src/server.ts renderLessonsPublicIndex + renderLessonsPublicPermalink).
  Net-new testid `lessons-failure-modes-cross-link` with href `/failures`.
  Net-new CSS selector group `.failures-public` in web/style.css that
  matches the centred 80ch reading surface of `.lessons-public` and adds
  horizontal-scroll on the `<pre>` excerpt block for mobile (375px).
