---
id: 0039
title: Fleet changelog - one chronological page of every merged PR across every project, ticket-linked
status: shipped
priority: P1
area: portal
created: 2026-06-05
owner: gtm-innovation
---

## User story

As a fleet operator on Wednesday at 3pm trying to remember "when did
the cost-per-PR card actually merge, and was it in fleet-control or
courtiq?", I want a `/changelog` page in the portal that lists every
merged agent PR across every project chronologically (newest first),
each row showing project · PR title · ticket id · merged-at · size,
filterable by project and date range and full-text searchable, so that
the cross-project ship history I currently have to assemble by
scrolling `gh pr list` in four repos becomes one scannable page.

## Why now (four lenses)

### Product Owner
The portal has three surfaces that touch merged-PR data:
- 0019 prs_merged count (just a number on the project card)
- 0026 streak heatmap (just calendar dots, no titles)
- 0012 digest (per-week, deep-scroll)
None of them answer "show me a flat list of everything the fleet
shipped, when, with the ticket behind it." That's the question the
operator actually has during a "what did I ship this month?" review,
a "when did the bug regression land?" debug, or a "show this list to
my collaborator" share. A `fleetChangelog(db, opts)` helper that
selects from `pr WHERE state='MERGED' AND is_agent=1` joined to
`project` and `ticket_commit_link` (0018) gives the operator the
single chronological surface that all the existing per-project
surfaces fragment. Pure composition - no new ingest, no new schema.
The page is the most "show me" surface in the portal: one scroll, one
search, no decoration.

### Stakeholder
Widens the moat on `portal` and growth - this is the single
"I see my whole fleet on one page" surface that no other tool can
produce. GitHub itself has no concept of "my fleet" - the operator
has to scroll each repo separately. The closest GitHub-native surface
is the user's `pulls?author=@me` filter, which mixes agent PRs with
human PRs, doesn't ticket-link, and has no cross-project totals.
Per the cross-fleet courtiq lesson "the share-worthy moment is the
structural impossibility for other tools," a screenshot of "every
merged PR my autonomous fleet shipped in May, ticket-linked, on one
page" is a categorically different angle from cost (0035) or shape
(0034) or weekly (0037) - it's the PROVENANCE surface. The same
ticket-commit-link table (0018) that gives the digest its narrative
arc gives the changelog its trust surface: every row links to BOTH
the PR (the diff) and the ticket (the intent). That pairing is the
moat - intent + execution in one place is what makes a fleet
auditable.

### User (operator at Wednesday 3pm)
A new top-bar link `CHANGELOG` between the existing brand and the
fleet-summary (or beside the `LESSONS` link from 0036). Tap it;
`/changelog` renders:

```
CHANGELOG                           [search: ___]    [project: all v]
                                    [from: ____]   [to: ____]

2026-06-04
  fleet-control  Friday wrap weekly card        #88  +312/-18  ticket 0037
  fleet-control  Lessons portal view            #86  +488/-22  ticket 0036
  courtiq        Coach drill signals route      #312 +118/-7   ticket 0152

2026-06-03
  fleet-control  Cost per merged PR             #85  +201/-9   ticket 0035
  digitalcraft   Hero gradient refresh          #67  +24/-12   ticket 0029
  ...

(showing 47 of 312 · load more)
```

Rows group by calendar date. Search filters by substring across PR
title + ticket id (case-insensitive). Project filter dropdown limits
to one project (or "all"). Date range filters narrow the window.
Tapping a row's PR number opens the PR on GitHub (new tab); tapping
the ticket id opens the project's backlog page in a new tab. On phone
the columns collapse to two lines per row: title + (PR, size, ticket
id) on the second line. The page is paginated 50 rows at a time via
a cursor to keep the initial payload small.

### Growth
The screenshot worth sharing is the changelog filtered to "the last
30 days, all projects" - a flat list of 80 merged PRs across 6 repos
with ticket-linked intent on every row. That artifact answers the
prospective-operator question "what does an autonomous fleet
actually SHIP?" more concretely than any other surface. The "show
me" pitch: "this is every PR my agents merged across every repo last
month. Click any row to see the diff. Click any ticket to see the
intent. Local-only, no SaaS." More compelling than 0026's streak
heatmap (shape only) or 0035's $/PR ratio (cost only) because it
shows the actual WORK, with provenance. Distinct from 0037's
Friday wrap (one card, one week) by being the deep archive surface.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/views.ts` exports `fleetChangelog(db, opts?: {limit?:
      number, cursor?: string, projectSlug?: string, from?: string,
      to?: string, search?: string}): {rows: Array<{project_slug:
      string, project_name: string, pr_number: number, pr_title:
      string, pr_url: string, merged_at: string, additions: number,
      deletions: number, ticket_id: string | null}>, next_cursor:
      string | null, total: number, generated_at: string}`. `limit`
      defaults to 50, capped at 200. `cursor` is the `(merged_at,
      pr_number)` of the last row in the previous page; the next
      page selects rows strictly older than that pair (tiebreak by
      pr_number descending). The base query is `pr WHERE state =
      'MERGED' AND is_agent = 1` joined to `project` on `project_id`
      and LEFT JOIN `ticket_commit_link` (0018) on `pr_number`.
      Sorting is `ORDER BY fetched_at DESC, pr_number DESC` (we
      treat `fetched_at` as the merged-at proxy since `pr.fetched_at`
      is updated on the merge tick; LESSONS § "node:sqlite's .all()
      needs `as unknown as T[]`" applies to the row narrowing).
      Per LESSONS § "time-pinned tests must NOT derive seed
      timestamps from `new Date()`", every seed anchors to the
      pinned `now`. Test: seed 5 merged PRs across 2 projects with
      known sizes and ticket ids, assert all 5 are returned in
      newest-first order with their ticket ids resolved.
- [ ] Pagination: a 75-row dataset with `limit=50` returns 50 rows
      with `next_cursor` non-null; passing that cursor on the next
      call returns the remaining 25 with `next_cursor: null`. The
      cursor is opaque from the client's perspective (base64-encoded
      `${merged_at}|${pr_number}` string), decoded server-side. The
      cursor decoder rejects malformed input with a 400 response
      (NOT a 500). Test: paginate through 75 rows, assert the
      cursor handoff and that no row appears twice; submit a
      malformed cursor, assert 400.
- [ ] Project filter: `projectSlug='courtiq'` returns only courtiq
      rows. An unknown slug returns `{rows: [], next_cursor: null,
      total: 0}` (NOT a 404 - the changelog is per-fleet, missing
      projects are silent filters). Test: seed 5 PRs across 3
      projects, filter to one slug, assert only that project's rows.
- [ ] Date range filter: `from` and `to` are ISO date strings
      (date-only or full datetime). Rows are filtered by
      `fetched_at >= from AND fetched_at < to + 1d` when both are
      present, or one-sided when only one is. Invalid date strings
      return a 400 (NOT silent ignore - the operator's intent was
      to filter; silently widening is a bug). Test: seed rows
      across 30 days, request `from=2026-06-01&to=2026-06-03`,
      assert only rows in that window; submit `from=banana`,
      assert 400.
- [ ] Search filter: substring match (case-insensitive) against
      `pr_title || ' ' || COALESCE(ticket_id, '')`. SQL uses
      `LIKE` with `%search%` after escaping `%`, `_`, and `\` in
      the input (per LESSONS § "no shell-string composition" and
      its SQL analogue - never compose LIKE patterns from raw
      input). Test: seed 5 PRs with one titled "Cost per merged
      PR", search "cost", assert only that row; search "0035",
      assert the row whose ticket_id matches; search "100%" (with
      escapable meta-chars), assert no SQL injection and zero
      false positives.
- [ ] `GET /api/fleet/changelog` returns the shape from AC1. Query
      params: `limit`, `cursor`, `project`, `from`, `to`, `search`.
      Requires `read` scope. Test: hit without auth -> 401; with
      `read` and default params -> 200 plus the shape; with
      `project=fleet-control&search=wrap` -> 200 with only
      matching rows.
- [ ] Caching: the route response sets `Cache-Control: max-age=60`
      (1 min - fresh enough that a PR merged at 2:59 shows by 3:00).
      The handler memoises by the FULL query-param tuple (per
      LESSONS § "in-process dedup sets need an explicit reset hook
      for tests", expose `_resetChangelogCacheForTests()` AND
      `_getChangelogCacheBuildsForTests()` per LESSONS § "expose a
      build counter for cache-hit tests, not a fetcher swap"). The
      cache is cleared whenever the `pr` table receives an INSERT
      or UPDATE on a MERGED row - reuse the existing
      `runIngestPass` post-ingest hook (no new triggers, no new
      table). Test: two identical queries assert one build; vary
      one param, assert another build; simulate an ingest
      completing, assert next call rebuilds.
- [ ] `web/app.js` adds a new top-bar link `CHANGELOG` (beside
      `LESSONS` from 0036) and a hash route `/changelog` that
      renders the page. Rows are grouped under date headers; the
      search input + project select + date inputs filter
      client-side AND re-fetch from the server when the project
      or date changes (search is client-side over the current
      page only; new searches re-fetch with the param). Tapping
      the PR number opens `pr_url` in a new tab; tapping the
      ticket id opens
      `/p/<slug>/backlog/<ticket_id>` in the same tab (a clean
      URL even though the SPA currently has no per-ticket page -
      future-proofing the link; for v1 the route falls back to
      the project page). Per LESSONS § "defence-in-depth secret
      redaction at the renderer boundary", every operator-visible
      string passes through `redactSecrets` before insertion -
      PR titles historically contain repo URLs / SHAs which the
      redactor must NOT trip on, AND any future leak of an actual
      token in a PR title is silently stripped. The page
      container has `data-testid="fleet-changelog"`. Test: stub
      the API with 5 rows, assert the DOM groups by date and
      contains the expected anchors.
- [ ] Empty state: when zero merged PRs exist (fresh install)
      OR all filters exclude everything, the page renders a short
      empty-state copy: "No merged PRs yet" OR "No matches for
      these filters" with a link to clear filters. NO error, NO
      crash. Test: stub the API with `{rows: [], total: 0}`,
      assert the empty copy is rendered.
- [ ] Mobile: at 375px viewport the row collapses to two lines
      (title on top, project + PR + ticket on bottom); the
      filter row stacks (search on its own line, project /
      from / to on the next). No horizontal scroll (per 0011
      conventions). At >=600px the row is one line. Test:
      assert via the existing mobile-portal text-level CSS
      contract at 375px and 600px.
- [ ] Performance: `fleetChangelog(db, {limit: 50})` against a
      fleet with 1000 merged PRs across 10 projects completes
      in under 30ms. The HTTP route end-to-end (cache miss)
      completes in under 80ms. Per LESSONS § "in-process
      startServer() tests need an empty-roots config + run-row
      seeds", the server-boot tests plant a tmp
      `fleet-control.config.json` in cwd and restore on
      cleanup. Test: seed the dataset, time both, assert
      thresholds (skip if `process.env.PERF !== "1"`).
- [ ] Snapshot integration (0013): the existing read-only
      shareable snapshot SHOULD optionally embed the last 50
      changelog rows (anonymized via `anonymize()` per the
      existing 0013 pattern - project slugs replaced with
      stable surrogates). Adding this is an explicit AC: the
      mint API gains an `include_changelog?: boolean` option
      (default `false` to preserve existing snapshot
      behaviour); when `true`, the payload's
      `payload.changelog` carries the anonymized rows. Test:
      mint a snapshot with `include_changelog: true`, assert
      the share page renders the changelog section with
      anonymized slugs; mint without the flag, assert the
      payload is byte-identical to today's.
- [ ] No new runtime deps. `tsc --noEmit` clean. No
      shell-string composition. No JSON-shape break to any
      existing `/api/...` route - the new
      `/api/fleet/changelog` is net-new; the snapshot payload's
      `changelog` key is additive and only present when the
      mint opt-in flag is set. No schema migration - composes
      existing `pr`, `project`, and `ticket_commit_link`
      tables. Per LESSONS § "no backticks inside template-
      literal SQL strings", identifiers in any new SQL stay
      plain.

## Out of scope

- A "include human PRs" toggle. The fleet is the agent
  surface; human PRs are not the operator's autonomous-loop
  signal. The 0023 PR card already shows mixed PRs on a
  project page if needed.
- A "fork by author" view (per-agent ship breakdown). The
  fleet doesn't distinguish ships by individual agent
  identities meaningfully - they're all `claude` runs of
  different phases. The 0014 leaderboard covers
  phase-level breakdown.
- Inline diff preview on each row. The 0007 PR card already
  has inline diff; the changelog is the LIST surface, not
  the DETAIL surface. Tapping the PR number opens the diff
  in a new tab.
- A "build a release-notes draft from these PRs" exporter.
  That's an authoring surface, not an observability one.
  Clean follow-up if asked.
- Bidirectional sync (operator edits a row, it writes back
  to GitHub). The portal is read-only on PR metadata.
- An RSS / Atom feed of the changelog. A clean follow-up
  if asked; the v1 surface is the page.
- A "compare two date ranges" diff view. The single date
  range is enough for v1; comparing windows is a deep-dive
  surface that belongs in 0012's digest.
- LLM-authored "here's what shipped this month" prose
  summaries on top of the list. The list IS the artifact;
  prose adds runtime cost and the operator-trust problem
  the deterministic surfaces in 0033 / 0037 solved.
- Real-time updates (SSE-pushed new merges). The 1-min
  cache plus the existing fleet ingest pass is responsive
  enough; SSE adds an lifecycle bug surface documented in
  LESSONS § "async streaming tails: snapshot the path
  before each read" that we don't need to re-introduce.

## Engineering notes

- `src/views.ts` - new `fleetChangelog(db, opts)` helper
  next to the existing `fleetView`, `digest`, and so on.
  The base query is `SELECT FROM pr JOIN project ON
  pr.project_id = project.id LEFT JOIN ticket_commit_link
  ON ticket_commit_link.pr_number = pr.number AND
  ticket_commit_link.project_id = project.id WHERE
  pr.state = 'MERGED' AND pr.is_agent = 1 ORDER BY
  pr.fetched_at DESC, pr.number DESC LIMIT ? OFFSET ?`.
  Cursor decoding splits on `|`. Filters are added as
  parameterised `WHERE` clauses; the search LIKE pattern
  escapes meta-chars. Per LESSONS § "node:sqlite's .all()
  needs `as unknown as T[]`", every row narrowing uses the
  double-cast.
- `src/server.ts` - one new route `GET /api/fleet/changelog`.
  Reuse the existing `read` scope middleware. The 1-min
  memo cache is keyed by the full query-param tuple per
  LESSONS § "expose a build counter for cache-hit tests,
  not a fetcher swap" - expose
  `_resetChangelogCacheForTests()` and
  `_getChangelogCacheBuildsForTests()`. The cache
  invalidation hook lives in `src/ingest/index.ts` (or
  wherever `runIngestPass`'s post-ingest tail is) - one
  call to the reset helper after PRs are reconciled.
- `src/snapshot.ts` - extend the existing `SnapshotCreateOpts`
  with an optional `include_changelog?: boolean` flag. When
  set, `anonymize()` walks the changelog rows the same way
  it walks projects (per the existing 0013 pattern) and
  embeds the result under `payload.changelog`. The share
  page (`renderSharePage`) renders the new section ONLY
  when present. Per the existing 0013 contract: anonymized
  slugs are stable surrogates, never the real slugs.
- `web/app.js` - new top-bar `CHANGELOG` link wired into
  the existing hash router. New `renderChangelogPage(data)`
  helper that builds the date-grouped list. Search,
  project, and date inputs are vanilla `addEventListener`;
  search filters the current page client-side, project and
  date re-fetch with new params. Per LESSONS § "defence-in-
  depth secret redaction at the renderer boundary", every
  operator-visible string passes through `redactSecrets`
  before insertion.
- `web/style.css` - one selector group for the changelog
  page (date headers, row layout, filter bar). Reuse
  existing CSS variables - no new palette.
- `tests/changelog.test.ts` (new) - one `test(...)` per AC
  checkbox. Per LESSONS § "time-pinned tests must NOT
  derive seed timestamps from `new Date()`", every seed
  timestamp anchors to the test's pinned `now`. The
  pagination test seeds exactly 75 rows so the cursor
  handoff is unambiguous. The search-escape test asserts
  no SQL injection by including LIKE meta-chars in the
  query. Per LESSONS § "in-process startServer() tests
  need an empty-roots config + run-row seeds", the server
  tests plant a tmp `fleet-control.config.json` in cwd
  and restore on cleanup.
- No new runtime deps. No schema migration. Pairs with
  0007 (the PR diff is the per-row deep-dive destination -
  tap-through), 0012 (the digest is the windowed-summary
  counterpart - this is the unfiltered list), 0013 (the
  shareable snapshot grows an optional changelog section),
  0018 (the ticket-commit-link table is the join that
  makes every row carry provenance), 0019 (the
  prs_merged count on project cards is the per-project
  rollup of this list), 0026 (the streak heatmap is the
  shape; this is the substance), and 0036 (the LESSONS
  link in the top bar is the visual neighbour).

## Implementation log

- 2026-06-05 — implementation-dev: branch `feat/0039-fleet-changelog-page`
  opened. Mark ticket in-progress, sync README. Schema-vs-prose
  reconciliation (per LESSONS § "groomer prose can disagree with the
  schema; the schema wins"): grepped every `INSERT INTO pr ...` writer
  + every existing WHERE-state read in `src/views.ts`. Two findings:
  (a) `src/ingest/prs.ts` only writes OPEN PRs (state literal `'open'`
  lower-case) — it never inserts MERGED rows; (b) every existing
  reader in `src/views.ts` that targets merged PRs uses `state =
  'MERGED'` (UPPER-case). So MERGED rows are seeded externally
  (tests, future ingest, fixtures) and the repo-wide convention is
  uppercase `'MERGED'`. The ticket's prose is correct here. The
  changelog WHERE clause uses `pr.state = 'MERGED' AND pr.is_agent = 1`
  to match this convention. Same casing the rest of the file uses
  (`fleetStreak`, `costPerMergedPr`, `fridayWrap`, `mondayCatchUp`).
- 2026-06-05 — implementation-dev: ticket_commit_link join columns
  verified against `src/db.ts` lines 226-238: PK is (project_slug,
  commit_sha, ticket_id) with optional pr_number — same join keys the
  `mondayCatchUp` biggest-ship lookup uses (`project_slug + pr_number`).
  Cache-invalidation hook lives in `src/ingest/index.ts`
  `runIngestPass()` post-COMMIT tail; we wire it via a single
  `globalThis.__fleet_changelog_invalidate__` slot (registered by
  `src/server.ts` on load) so the ingest module doesn't import the
  server module — avoids the cycle that would otherwise arise from
  `src/server.ts` already importing `runIngestPass`. The daemon
  (which doesn't import the server) cleanly skips the call.
- 2026-06-05 — implementation-dev: `fleetChangelog(db, opts)` lives
  at the bottom of `src/views.ts`. Cursor encoding is base64 of
  `${merged_at}|${pr_number}`; the decoder validates the alphabet,
  the pipe position, the ISO timestamp shape, and the integer
  pr_number — any drift throws and the route handler maps the throw
  to a 400 response (NOT 500). Search LIKE meta-chars (`%`, `_`,
  `\`) are escaped before binding and the SQL uses
  `LIKE ? ESCAPE '\\'` so the operator's literal '100%' query
  doesn't wildcard. Snapshot integration: a new
  `include_changelog?: boolean` flag on `SnapshotCreateOpts`
  defaults to false — when off the payload is byte-identical to
  today's (no `changelog` key); when on, the rows are walked through
  a new `anonymizeChangelog()` that replaces slugs with the same
  `project-N` surrogates `anonymize()` uses for the fleet-view side.
- 2026-06-05 — implementation-dev: SPA. `#/changelog` route added.
  `web/index.html` grew a `CHANGELOG` top-bar link with
  `data-testid="topbar-changelog"`; `web/app.js` got
  `renderChangelogPage` + `renderChangelogRow` + a route handler
  that fetches `/api/fleet/changelog` and emits a
  `data-testid="fleet-changelog"` container. PR titles + ticket ids
  + project slugs pass through `redactSecrets` per LESSONS § secret
  redaction at the renderer boundary. `web/style.css` got a new
  `.changelog-*` selector group with a >=600px breakpoint per AC10
  (mobile-first: row collapses to two lines at 375px, one line at
  600px; filters stack on mobile, single row on desktop).
- 2026-06-05 — implementation-dev: full local gate green
  (`npm ci && npx tsc --noEmit && node scripts/check-backlog.mjs`)
  plus the changelog test file passes (23/23 + 1 PERF=1 skipped).
  Spot-checked the related suites
  (snapshot/riskiest-pr/monday-catchup/friday-wrap/glance): 129
  passing, 0 failing, 4 PERF skipped. Pre-existing failures on
  `tests/prs-merged.test.ts` and the welcome/quiet-hours subprocess
  tests reproduce on main and predate this PR (per LESSONS §
  "time-pinned tests must NOT derive seed timestamps from
  new Date()" — those tests are NOT gating checks).
